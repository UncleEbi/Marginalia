import test from 'node:test';
import assert from 'node:assert/strict';
import { extractFunction } from './helpers/extract-function.mjs';

// runDrillCard and the pause/resume/pause helpers read the drill state that public/app.js keeps in
// script scope, so the test installs those names as globals and drives a real card through its
// stages with a controllable clock and wait.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function installDrill() {
  const spoken = [];
  const waits = [];
  const rated = [];
  let now = 0;

  const el = () => ({ style: {}, textContent: '' });
  const saved = {};
  const set = (name, value) => {
    if (!(name in saved)) saved[name] = { had: name in globalThis, value: globalThis[name] };
    globalThis[name] = value;
  };
  const restore = () => {
    Object.entries(saved).forEach(([name, prev]) => {
      if (prev.had) globalThis[name] = prev.value;
      else delete globalThis[name];
    });
  };

  const realDateNow = Date.now;
  Date.now = () => now;

  set('isAudioDrillActive', true);
  set('isAudioDrillPaused', false);
  set('drillCards', [{ prompt: 'p0', answer: 'a0' }, { prompt: 'p1', answer: 'a1' }]);
  set('drillSessionCards', globalThis.drillCards);
  set('drillIndex', 0);
  set('drillReviewQueue', []);
  set('drillKnownCount', 0);
  set('drillRatingOpen', false);
  set('drillStage', 'prompt');
  set('drillStageCard', -1);
  set('drillStageLeftMs', 0);
  set('drillRunId', 0);
  set('drillTimer', null);
  set('drillWaitRelease', null);
  set('drillSpeechRelease', null);
  set('drillPauseSelect', { value: '2' });
  set('drillProgressText', el());
  set('drillProgressFill', el());
  set('drillPromptText', el());
  set('drillAnswerText', el());
  set('drillAnswerBox', el());
  set('drillPauseToggleBtn', el());
  set('playBookmarkChime', () => { });
  set('syncMediaSessionState', () => { });
  set('showToast', () => { });
  set('cancelDrillSpeech', () => { });
  set('finishAudioDrill', async () => { });
  set('rateDrillCard', (known) => { rated.push(known); });
  set('speakDrillText', (text) => { spoken.push(text); return Promise.resolve(); });
  // A wait the test completes itself: the pause path still reaches it through the real release
  // helper, but a 5s window costs no wall-clock time here.
  set('drillWait', (ms) => new Promise((resolve) => {
    waits.push({ ms, resolve });
    globalThis.drillWaitRelease = resolve;
  }));

  const runDrillCard = extractFunction('runDrillCard');
  set('runDrillCard', runDrillCard);
  set('releaseDrillCardWaits', extractFunction('releaseDrillCardWaits'));

  return {
    spoken,
    waits,
    rated,
    runDrillCard,
    pause: extractFunction('pauseAudioDrill'),
    resume: extractFunction('resumeAudioDrill'),
    advance: (ms) => { now += ms; },
    restore: () => { Date.now = realDateNow; restore(); }
  };
}

test('a paused card resumes at the beat it was on, not at its prompt', async () => {
  const drill = installDrill();
  try {
    // Card 1's prompt is read out, then the thinking pause starts its first second.
    const firstRun = drill.runDrillCard(0);
    let firstRunSettled = false;
    firstRun.then(() => { firstRunSettled = true; });
    await flush();

    assert.deepEqual(drill.spoken, ['Card 1 of 2. p0'], 'the question is read once');
    assert.equal(globalThis.drillStage, 'thinking');
    assert.equal(globalThis.drillRatingOpen, true, 'the prompt has been read, so the card is rateable');
    assert.equal(drill.waits.length, 1);
    assert.equal(drill.waits[0].ms, 1000);

    // Pause 0.4s into the chosen 2s of thinking.
    drill.advance(400);
    drill.pause();
    await flush();

    assert.equal(firstRunSettled, true, 'the suspended card finishes instead of leaving a dangling await');
    assert.equal(globalThis.drillStage, 'thinking', 'the card stays on the beat it was paused on');
    assert.equal(globalThis.drillStageLeftMs, 1600, 'and remembers what was left of it');
    assert.deepEqual(drill.spoken, ['Card 1 of 2. p0']);

    // Resume: the question is not read a second time, the countdown continues where it stopped.
    drill.resume();
    await flush();
    assert.deepEqual(drill.spoken, ['Card 1 of 2. p0'], 'resuming does not replay the question');
    assert.equal(drill.waits.length, 2);
    assert.equal(drill.waits[1].ms, 1000, 'the remaining 1.6s is counted down, not restarted at 2s');
    assert.equal(globalThis.drillAnswerText.textContent, 'Thinking... (2s)');

    // 1s later the countdown shows the last partial second.
    drill.advance(1000);
    drill.waits[1].resolve();
    await flush();
    assert.equal(drill.waits.length, 3);
    assert.equal(drill.waits[2].ms, 600);
    assert.equal(globalThis.drillAnswerText.textContent, 'Thinking... (1s)');

    // The pause runs out: the answer is revealed and the rating window opens.
    drill.advance(600);
    drill.waits[2].resolve();
    await flush();
    assert.deepEqual(drill.spoken, ['Card 1 of 2. p0', 'Answer: a0'], 'the answer is read once');
    assert.equal(globalThis.drillStage, 'rating');
    assert.equal(drill.waits.length, 4);
    assert.equal(drill.waits[3].ms, 5000);

    // Pausing inside the rating window keeps the time that was left of it.
    drill.advance(1000);
    drill.pause();
    await flush();
    assert.equal(globalThis.drillStageLeftMs, 4000);

    drill.resume();
    await flush();
    assert.deepEqual(drill.spoken, ['Card 1 of 2. p0', 'Answer: a0'], 'nor is the answer replayed');
    assert.equal(drill.waits.length, 5);
    assert.equal(drill.waits[4].ms, 4000, 'a pause does not hand out a fresh 5 second window');

    drill.advance(4000);
    drill.waits[4].resolve();
    await flush();
    assert.deepEqual(drill.rated, [true], 'the window still auto-advances as Known when it ends');
  } finally {
    drill.restore();
  }
});

test('pausing releases the card timer and utterance so no await is left suspended', async () => {
  const drillWait = extractFunction('drillWait');
  const release = extractFunction('releaseDrillCardWaits');
  const saved = {
    drillTimer: globalThis.drillTimer,
    drillWaitRelease: globalThis.drillWaitRelease,
    drillSpeechRelease: globalThis.drillSpeechRelease
  };
  try {
    globalThis.drillTimer = null;
    globalThis.drillWaitRelease = null;
    globalThis.drillSpeechRelease = null;

    let timerSettled = false;
    let speechReleased = false;
    const waiting = drillWait(60000).then(() => { timerSettled = true; });
    globalThis.drillSpeechRelease = () => { speechReleased = true; };

    release();
    await waiting; // a cleared timeout alone would leave this pending for a minute

    assert.equal(timerSettled, true, 'the timer wait settles on release');
    assert.equal(speechReleased, true, 'the utterance settles on release too');
    assert.equal(globalThis.drillTimer, null, 'and the timer is not left armed');
    assert.equal(globalThis.drillWaitRelease, null);

    release(); // releasing with nothing pending is a no-op
    assert.equal(timerSettled, true);
  } finally {
    Object.assign(globalThis, saved);
  }
});

test('speakDrillText settles when the drill pauses mid-sentence', async () => {
  const speakDrillText = extractFunction('speakDrillText');
  const release = extractFunction('releaseDrillCardWaits');
  const saved = {};
  const set = (name, value) => {
    if (!(name in saved)) saved[name] = { had: name in globalThis, value: globalThis[name] };
    globalThis[name] = value;
  };
  try {
    const utterances = [];
    set('isAudioDrillActive', true);
    set('activeEngine', 'browser');
    set('browserSpeech', { cancel: () => { }, speak: (u) => utterances.push(u) });
    set('SpeechSynthesisUtterance', function (text) { this.text = text; });
    set('normalizeForSpeech', (text) => text);
    set('playbackSpeed', 1);
    set('playbackVolume', 1);
    set('applyChosenVoice', () => { });
    set('drillSpeechRelease', null);

    let spokenSettled = false;
    const spoken = speakDrillText('Answer: a0').then(() => { spokenSettled = true; });
    await Promise.resolve();
    assert.equal(utterances.length, 1);
    assert.equal(spokenSettled, false, 'a browser pause() fires no onend, so the promise is still open');

    release(); // what pauseAudioDrill does
    await spoken;

    assert.equal(spokenSettled, true, 'the card is not left waiting on an utterance that will never end');
    assert.equal(globalThis.drillSpeechRelease, null);

    // The normal path still settles on onend.
    let endedSettled = false;
    const ended = speakDrillText('Answer: a1').then(() => { endedSettled = true; });
    await Promise.resolve();
    utterances[1].onend();
    await ended;
    assert.equal(endedSettled, true);
    assert.equal(globalThis.drillSpeechRelease, null);
  } finally {
    Object.entries(saved).forEach(([name, prev]) => {
      if (prev.had) globalThis[name] = prev.value;
      else delete globalThis[name];
    });
  }
});

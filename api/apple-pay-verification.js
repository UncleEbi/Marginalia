export default function handler(req, res) {
  const verificationString = 'PASTE_YOUR_EXACT_PAYSTACK_STRING_HERE';

  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Content-Disposition', 'inline');
  return res.status(200).send(verificationString);
}

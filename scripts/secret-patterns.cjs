'use strict';

const patterns = [
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/],
  ['GitHub token', /\b(?:gh[pousr]_[0-9A-Za-z]{30,}|github_pat_[0-9A-Za-z_]{30,})\b/],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
];

function assertNoSecretLiteral(name, text) {
  for (const [kind, pattern] of patterns) {
    if (pattern.test(text)) throw new Error(`${kind} literal in ${name}; remove it before release. Value omitted.`);
  }
}

module.exports = {assertNoSecretLiteral};

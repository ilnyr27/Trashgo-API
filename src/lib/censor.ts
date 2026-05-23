// Russian profanity filter — replaces mat with asterisks
// Covers root forms + common letter substitutions (о→0, а→@, е→3, etc.)

const normalize = (s: string) =>
  s.toLowerCase()
    .replace(/0/g, 'о').replace(/@/g, 'а').replace(/3/g, 'е')
    .replace(/\$/g, 'с').replace(/1/g, 'и').replace(/4/g, 'ч')
    .replace(/\*/g, '').replace(/[_\-\.]/g, '');

// Roots to block (Cyrillic, covers inflections via prefix/suffix wildcards in regex)
const ROOTS = [
  'хуй', 'хуе', 'хуя', 'хую', 'хуи', 'хуев', 'хуём', 'хуйн', 'захуй', 'нахуй', 'похуй', 'ёхуй',
  'пизд', 'пёзд', 'пёзд',
  'еба', 'ёба', 'ебл', 'ёбл', 'ебан', 'ёбан', 'ебат', 'ёбат', 'ебут', 'еби', 'ёби',
  'блять', 'блядь', 'бляд', 'блят',
  'сука', 'суки', 'суке', 'сукой', 'суку',
  'мудак', 'мудил', 'мудач',
  'залуп', 'залупа',
  'манда', 'манды',
  'шлюх',
  'ёпт', 'епт',
  'пиздец', 'пиздёж', 'пиздат',
  'пиздёт', 'пиздит', 'пиздят',
  'хуёв', 'хуёс',
  'ёб твою', 'ёб вашу',
];

const PATTERNS = ROOTS.map(r => new RegExp(r, 'gi'));

function mask(word: string): string {
  if (word.length <= 2) return word[0] + '*'.repeat(word.length - 1);
  return word[0] + '*'.repeat(word.length - 2) + word[word.length - 1];
}

export function censor(text: string): string {
  if (!text) return text;

  // Work on a normalized copy to detect bad words, but replace in original
  let result = text;
  const norm = normalize(text);

  for (const pattern of PATTERNS) {
    // Test on normalized text
    const normTest = new RegExp(pattern.source, 'gi');
    if (!normTest.test(norm)) continue;

    // Replace in the original string (word boundary approach)
    result = result.replace(
      new RegExp(`[а-яёА-ЯЁa-zA-Z0-9@$]*${pattern.source}[а-яёА-ЯЁa-zA-Z0-9]*`, 'gi'),
      m => mask(m)
    );
  }

  return result;
}

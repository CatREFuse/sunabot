const LATIN_OR_CJK = /[a-z0-9_]+|[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/gu;
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;

export function tokenizeKnowledgeText(input: string) {
  const normalized = input.toLocaleLowerCase().normalize("NFKC");
  const tokens = [...normalized.matchAll(LATIN_OR_CJK)].map((match) => match[0]);
  const cjkCharacters = [...normalized].filter((character) => CJK.test(character));
  for (let index = 0; index < cjkCharacters.length - 1; index += 1) {
    tokens.push(`${cjkCharacters[index]}${cjkCharacters[index + 1]}`);
  }
  return tokens;
}

export function knowledgeFtsQuery(input: string) {
  const tokens = [...new Set(tokenizeKnowledgeText(input))].slice(0, 64);
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR ");
}

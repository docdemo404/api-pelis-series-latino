function normalizeTitle(title) {
  return title
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\s*\(\d{4}\)\s*$/, "")
    .replace(/\bspiderman\b/g, "spider man")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

console.log('1:', normalizeTitle('Spider-Man 2'));
console.log('2:', normalizeTitle('Spider-Man 2 (2004)'));
console.log('3:', normalizeTitle('Spiderman 2'));
console.log('Match?', normalizeTitle('Spider-Man 2') === normalizeTitle('Spiderman 2 (2004)'));

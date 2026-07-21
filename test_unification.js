function getCanonicalTitleKey(title) {
  let norm = title
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\s*\(\d{4}\)\s*$/, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Strip generic suffixes like "la pelicula", "pelicula", "hd"
  norm = norm
    .replace(/\b(la pelicula|pelicula|the movie|hd)\b/g, "")
    .replace(/\bspiderman\b/g, "spider man")
    .replace(/\bspider man 1\b/g, "spider man")
    .replace(/sin camino a casa/g, "no way home")
    .replace(/lejos de casa/g, "far from home")
    .replace(/de regreso a casa/g, "homecoming")
    .replace(/un nuevo universo/g, "into the spider verse")
    .replace(/traves del spider verso/g, "across the spider verse")
    .replace(/\s+/g, " ")
    .trim();

  return norm;
}

const titlesToTest = [
  ["Spider-Man 2", "Spider-Man 2 (2004)"],
  ["Spiderman: Lejos de Casa", "Spider-Man: Lejos de casa (2019)"],
  ["Spiderman: Sin Camino a Casa", "Spider-Man: No Way Home (2021)"],
  ["Spider-Man: Un nuevo universo", "Spiderman: Un Nuevo Universo (2018)"],
  ["Garfield: La película", "Garfield (2004)"]
];

console.log('=== TEST CANONICAL TITLE KEY MATCHES ===');
titlesToTest.forEach(([t1, t2]) => {
  const k1 = getCanonicalTitleKey(t1);
  const k2 = getCanonicalTitleKey(t2);
  console.log(`"${t1}" [${k1}] <===> "${t2}" [${k2}] => MATCH? ${k1 === k2}`);
});

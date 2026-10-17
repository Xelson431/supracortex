export async function fetchData(url) {
  const res = await fetch(url);
  return res.json();
}

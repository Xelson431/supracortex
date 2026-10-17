import { fetchData } from "./api.mjs";

export async function getUser(id) {
  return fetchData(`https://example.com/users/${id}`);
}

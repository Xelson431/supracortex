import { getUser } from "./service.mjs";
import { fetchData } from "./api.mjs";

export async function main(id) {
  const user = await getUser(id);
  const extra = await fetchData("https://example.com/extra");
  return { user, extra };
}

import { AccountError } from "../accounts";
import { accountRuntime } from "../runtime";
export async function viewer(request: Request) {
  const user = await accountRuntime().requireUser(request);
  if (!["owner", "staff"].includes(user.role))
    throw new AccountError(403, "This account has no access to the shop.");
  return user;
}
export async function ownerOnly(request: Request) {
  const user = await viewer(request);
  if (user.role !== "owner") throw new AccountError(403, "Only the owner can do this.");
  return user;
}

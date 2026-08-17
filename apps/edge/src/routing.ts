export function isApiRequest(pathname: string): boolean {
  return pathname.startsWith("/api/");
}

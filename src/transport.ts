export function serviceUrl(value: string, name: string, allowHttp: boolean): string {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:"))
  ) {
    throw new Error(
      `${name} requires HTTPS without embedded credentials, query or fragment; trusted private HTTP requires TELESEERR_ALLOW_INSECURE_HTTP=true`,
    );
  }
  return url.toString().replace(/\/$/, "");
}

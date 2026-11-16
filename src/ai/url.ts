/**
 * Repairs pasted endpoint values: duplicated protocol prefixes like
 * `https://https://host`, stray whitespace and trailing slashes.
 */
export function sanitizeBaseUrl(raw: string): string {
  let value = (raw ?? "").trim().replace(/\s+/g, "");

  const duplicated = /^(https?:\/\/)+(https?:\/\/.*)$/i.exec(value);
  if (duplicated) value = duplicated[2];

  return value.replace(/\/+$/, "");
}

/** Host part of a URL, or the raw string when it cannot be parsed. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** Turns low-level network failures into something a user can act on. */
export function describeNetworkError(error: unknown, url: string): string {
  const message = error instanceof Error ? error.message : String(error);
  const host = hostOf(url);

  if (message.includes("ERR_NAME_NOT_RESOLVED")) {
    return `域名无法解析：${host}\n请检查「接口地址」是否完整且没有重复的 https://（正确示例：https://api.deepseek.com/v1）`;
  }

  if (message.includes("ERR_CONNECTION_REFUSED")) {
    return `连接被拒绝：${host}\n如果使用本地模型，请确认服务已经启动。`;
  }

  if (message.includes("ERR_INTERNET_DISCONNECTED")) {
    return "当前没有网络连接。";
  }

  if (message.includes("ERR_CERT") || message.includes("SSL")) {
    return `HTTPS 证书校验失败：${host}`;
  }

  if (message.toLowerCase().includes("timeout")) {
    return `请求超时：${host}`;
  }

  return `${message}\n请求地址：${url}`;
}

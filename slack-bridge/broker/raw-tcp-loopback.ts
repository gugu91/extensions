import * as net from "node:net";

function normalizeTcpHost(host: string): string {
  const trimmed = host.trim();
  const unwrapped =
    trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  return unwrapped.toLowerCase().replace(/\.$/, "");
}

function isLoopbackIpv4Host(host: string): boolean {
  if (net.isIP(host) !== 4) {
    return false;
  }

  const octets = host.split(".");
  if (octets.length !== 4) {
    return false;
  }

  return (
    octets[0] === "127" &&
    octets.every((octet) => {
      if (!/^\d+$/.test(octet)) {
        return false;
      }
      const value = Number(octet);
      return value >= 0 && value <= 255;
    })
  );
}

export function isLoopbackTcpHost(host: string): boolean {
  const normalized = normalizeTcpHost(host);
  if (normalized === "localhost" || normalized === "::1") {
    return true;
  }

  if (normalized.startsWith("::ffff:")) {
    return isLoopbackTcpHost(normalized.slice("::ffff:".length));
  }

  return isLoopbackIpv4Host(normalized);
}

export function assertLoopbackTcpHost(host: string, targetDescription: string): void {
  if (isLoopbackTcpHost(host)) {
    return;
  }

  throw new Error(
    `Refusing ${targetDescription} on non-loopback raw TCP host "${host}". Raw TCP broker endpoints are limited to loopback-only hosts until a secure remote transport exists.`,
  );
}

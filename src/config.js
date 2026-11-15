// -----------------------------------------------------------------------------
// The configuration the user fills (manifest `config_schema`), normalized:
// the address of the owserver (host and optional port, 4304 by default) and
// the interval between two reads. The address parser comes from
// gladys-iskra (approved), with the port of owserver and the addresses that
// can never be one server refused.
// -----------------------------------------------------------------------------

import { isIP } from 'node:net';
import { DEFAULT_INTERVAL_SECONDS, DEFAULT_PORT, INTERVAL_CHOICES } from './constants.js';

const LABEL = /^[a-z0-9](?:[a-z0-9_-]{0,61}[a-z0-9])?$/i;

/** An IPv4 address that is no single server: any, broadcast, multicast, reserved. */
function badIpv4(host) {
  const parts = host.split('.').map(Number);
  return parts[0] === 0 || parts[0] >= 224 || host === '255.255.255.255';
}

/** An IPv6 address that is no single server: unspecified or multicast. */
function badIpv6(host) {
  const bare = host.toLowerCase();
  return bare === '::' || /^0*:0*:0*:0*:0*:0*:0*:0*$/.test(bare) || /^ff/.test(bare);
}

/**
 * An address typed by the user: an IP address or a host name, with an
 * optional port. A pasted URL ("owserver://192.168.1.30:4304/") is reduced
 * to its host and port.
 * @returns {{ host: string, port: number } | { empty: true } | { error: 'invalid' }}
 */
export function parseAddress(raw) {
  let text = String(raw ?? '').trim();
  if (text === '') {
    return { empty: true };
  }
  if (text.length > 300 || /[^\x21-\x7e]/.test(text)) {
    return { error: 'invalid' };
  }
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/[/?#].*$/, '');
  if (text.includes('@')) {
    return { error: 'invalid' };
  }
  const bracketed = /^\[([0-9a-f:.]+)\](?::(\d{1,5}))?$/i.exec(text);
  if (bracketed) {
    const host = bracketed[1].toLowerCase();
    if (isIP(host) !== 6 || badIpv6(host)) return { error: 'invalid' };
    return withPort(host, bracketed[2]);
  }
  if (/^[0-9a-f:.]+$/i.test(text) && (text.match(/:/g) ?? []).length >= 2) {
    const host = text.toLowerCase();
    if (isIP(host) !== 6 || badIpv6(host)) return { error: 'invalid' };
    return { host, port: DEFAULT_PORT };
  }
  const match = /^(.*?)(?::(\d{1,5}))?$/.exec(text);
  const host = match[1].toLowerCase();
  if (/^[\d.]+$/.test(host)) {
    if (isIP(host) !== 4 || badIpv4(host)) return { error: 'invalid' };
    return withPort(host, match[2]);
  }
  if (host.length > 253 || !host.split('.').every((label) => LABEL.test(label))) {
    return { error: 'invalid' };
  }
  return withPort(host, match[2]);
}

function withPort(host, port) {
  if (port === undefined) {
    return { host, port: DEFAULT_PORT };
  }
  const number = Number(port);
  if (!Number.isInteger(number) || number < 1 || number > 65535) {
    return { error: 'invalid' };
  }
  return { host, port: number };
}

/** The interval chosen (seconds), one of the choices, else the default. */
function intervalOf(raw) {
  const value = typeof raw === 'string' && /^\d{1,4}$/.test(raw.trim()) ? Number(raw) : raw;
  return INTERVAL_CHOICES.includes(value) ? value : DEFAULT_INTERVAL_SECONDS;
}

/** The address as shown to the user: host, and the port when it is not 4304. */
export const addressText = (config) =>
  config.host === ''
    ? ''
    : `${config.host.includes(':') ? `[${config.host}]` : config.host}${
        config.port === DEFAULT_PORT ? '' : `:${config.port}`
      }`;

export function normalizeConfig(raw = {}) {
  const parsed = parseAddress(typeof raw?.address === 'string' ? raw.address : '');
  const ok = !parsed.error && !parsed.empty;
  return {
    host: ok ? parsed.host : '',
    port: ok ? parsed.port : DEFAULT_PORT,
    invalidAddress: Boolean(parsed.error),
    intervalSeconds: intervalOf(raw?.interval_seconds),
  };
}

/** Whether the form is complete enough to read the owserver. */
export const isComplete = (config) => config.host !== '';

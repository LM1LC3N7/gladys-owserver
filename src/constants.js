// -----------------------------------------------------------------------------
// Constants shared by the integration. Every key stored by Gladys (actions,
// manifest keys, feature keys in src/owserver/families.js) is forever: never
// rename one.
// -----------------------------------------------------------------------------

export const ACTIONS = { TEST: 'test_connection', ACCEPT_COUNTERS: 'accept_counter_drops' };

/**
 * The external id of a 1-Wire device: `probe:<family>-<serial>` (for
 * example `probe:28-4AEC29CDBAAB`), its 64-bit ROM id as owserver lists it,
 * the dot replaced by a dash. The ROM id is burnt into the chip: another
 * address of the owserver, or the probe moved to another bus, keeps its
 * device and its history.
 */
export const EXTERNAL_ID_TYPE = 'probe';

// --- The owserver protocol (owfs.org, "owserver protocol") ---------------------------
/** The port registered for owserver. */
export const DEFAULT_PORT = 4304;
/** Message types (word 3 of a request). */
export const MSG = { READ: 2, DIRALL: 7 };
/**
 * The flag word sent with every request: `ownet` (0x100) only. Everything
 * else at 0 on purpose: temperatures in Celsius whatever the server is set
 * to, the ids in the `f.i` form (`/28.4AEC29CDBAAB`), no alias names, no
 * special directories (bus.0, settings...), no persistent connection (one
 * connection per request, closed by both sides after the answer).
 */
export const FLAGS = 0x100;
/** The data size asked for a read: a value of a probe is a few bytes. */
export const READ_SIZE = 4096;
/** The header of a message, both ways: six 32-bit big-endian words. */
export const HEADER_BYTES = 24;
/** A larger payload is not an owserver answer for us: cut before it is read. */
export const MAX_PAYLOAD = 64 * 1024;
/** A request and its answer, the connection included, never take longer. */
export const REQUEST_TIMEOUT = 10_000;
/**
 * Without a single byte for this long, the request is given up (owserver
 * sends a "ping" header while a slow read goes on).
 */
export const IDLE_TIMEOUT = 5_000;
/** At most this many entries of the root directory are looked at. */
export const MAX_ENTRIES = 512;
/** At most this many supported devices are read (and offered in Discovery). */
export const MAX_PROBES = 64;

// --- Schedule ------------------------------------------------------------------------
const SECOND = 1000;
const MINUTE = 60 * SECOND;
/** The intervals the user may choose (seconds), and the default one. */
export const INTERVAL_CHOICES = [30, 60, 120, 300];
export const DEFAULT_INTERVAL_SECONDS = 60;
/**
 * Gladys takes 300 states a minute from an integration: with many features,
 * the interval grows so that a full read stays under this many a minute.
 */
export const STATES_PER_MINUTE = 250;
/** An unreachable owserver or a wrong answer: tries after 30 s, doubled up to 10 minutes. */
export const RETRY_MIN = 30 * SECOND;
export const RETRY_MAX = 10 * MINUTE;
/** A round of reads never takes longer: the probes left wait for the next one. */
export const ROUND_BUDGET = 60 * SECOND;
/** The time of the last read is written in /data at most once per this delay. */
export const ATTEMPT_SAVE_EVERY = MINUTE;
/** Unchanged values are sent again after this delay (publishChangedStates heartbeat). */
export const STATE_HEARTBEAT = 10 * MINUTE;
/** The test button answers within this delay (the manifest gives it 60 s). */
export const TEST_ANSWER_WITHIN = 45 * SECOND;
/** A stop saves /data, then waits for the read running at most this long and saves again. */
export const STOP_WAIT = 5 * SECOND;
/** Each save of a stop waits for /data at most this long (Docker stops after 10 s). */
export const STOP_SAVE_WAIT = 2 * SECOND;
/** /data unreadable: read again after this delay; a read waits for it at most this long. */
export const DATA_RETRY = 10 * SECOND;
export const DATA_WAIT = 10 * SECOND;

// --- Plausibility ----------------------------------------------------------------------
/** The range of the temperature probes (datasheets: -55 to +125 °C). */
export const TEMP_MIN = -55;
export const TEMP_MAX = 125;
/**
 * The power-on value of a DS18x20 that did not convert (a power glitch, a
 * parasite-powered probe that lost its supply): exactly 85 °C. Taken only
 * right after a temperature within RESET_NEAR of it.
 */
export const POWER_ON_VALUE = 85;
export const RESET_NEAR = 10;
/** The counters of a DS2423 are 32-bit. */
export const COUNTER_MAX = 2 ** 32 - 1;

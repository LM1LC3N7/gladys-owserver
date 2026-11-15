// -----------------------------------------------------------------------------
// Runtime texts shown in Gladys. Every text is a { en, fr } object. They never
// quote a text of the owserver: only our own words, error codes and values
// that passed our checks (ids matched the ROM id pattern, numbers parsed).
// -----------------------------------------------------------------------------

const seconds = (ms) => Math.max(1, Math.round(ms / 1000));
const minutes = (ms) => Math.max(1, Math.round(ms / 60_000));
export const delay = (ms) => {
  // Rounded first: 59.99 s is told "1 min", never "60 s".
  if (Math.round(ms / 1000) >= 60) return { en: `${minutes(ms)} min`, fr: `${minutes(ms)} min` };
  return { en: `${seconds(ms)} s`, fr: `${seconds(ms)} s` };
};

/** Our words for an error code of src/owserver/client.js. */
const REASON = {
  timeout: { en: 'no answer in time', fr: 'pas de réponse à temps' },
  unreachable: {
    en: 'unreachable (is owserver running, on this port?)',
    fr: 'injoignable (owserver tourne-t-il, sur ce port ?)',
  },
  closed: {
    en: 'connection closed before a complete answer (is it an owserver?)',
    fr: 'connexion fermée avant une réponse complète (est-ce bien un owserver ?)',
  },
  too_big: {
    en: 'answer too large, not that of an owserver',
    fr: 'réponse trop grande, pas celle d’un owserver',
  },
  server: { en: 'error of owserver', fr: 'erreur d’owserver' },
  bad_path: { en: 'invalid path', fr: 'chemin invalide' },
  unreadable: { en: 'value not readable', fr: 'valeur illisible' },
  out_of_range: { en: 'value out of range', fr: 'valeur hors plage' },
  budget: { en: 'not read this time (slow bus)', fr: 'pas lu cette fois (bus lent)' },
};

const reason = (code, errno) => {
  const text = REASON[code] ?? { en: 'error', fr: 'erreur' };
  return code === 'server' && Number.isInteger(errno)
    ? { en: `${text.en} ${errno}`, fr: `${text.fr} ${errno}` }
    : text;
};

const MAX_LISTED = 5;
/** At most a few ids, then "+n". */
const list = (items) =>
  items.length <= MAX_LISTED
    ? items.join(', ')
    : `${items.slice(0, MAX_LISTED).join(', ')} +${items.length - MAX_LISTED}`;

const join = (parts, lang) => parts.map((p) => p[lang]).join(' ');

const both = (en, fr) => ({ en, fr });

export const T = {
  incomplete: both(
    'Enter the address of your owserver (its port only if it is not 4304).',
    'Saisissez l’adresse de votre owserver (son port seulement s’il n’est pas 4304).',
  ),
  badAddress: both(
    'The address is not valid: an IP address or a host name, with an optional port (e.g. 192.168.1.30 or 192.168.1.30:4304).',
    'L’adresse n’est pas valide : une adresse IP ou un nom d’hôte, avec un port facultatif (ex. 192.168.1.30 ou 192.168.1.30:4304).',
  ),
  configUnread: both(
    'The configuration could not be read from Gladys: trying again.',
    'La configuration n’a pas pu être lue depuis Gladys : nouvel essai en cours.',
  ),
  waiting: (address) =>
    both(
      `Waiting for the first read of ${address}.`,
      `En attente de la première lecture de ${address}.`,
    ),
  failed: (address, code, errno, next) =>
    both(
      `owserver ${address}: ${reason(code, errno).en}. Next try in ${delay(next).en}.`,
      `owserver ${address} : ${reason(code, errno).fr}. Nouvel essai dans ${delay(next).fr}.`,
    ),
  noneRead: (address, count, notes) => {
    const head = both(
      `owserver ${address} answers, but none of its ${count} 1-Wire devices could be read.`,
      `owserver ${address} répond, mais aucun de ses ${count} appareils 1-Wire n’a pu être lu.`,
    );
    return both(join([head, ...notes], 'en'), join([head, ...notes], 'fr'));
  },
  ok: (address, read, listed, notes) => {
    const head =
      listed === 0
        ? both(
            `Connected to owserver ${address}: no supported 1-Wire device found.`,
            `Connecté à owserver ${address} : aucun appareil 1-Wire pris en charge trouvé.`,
          )
        : both(
            `Connected to owserver ${address}: ${read} of ${listed} 1-Wire devices read.`,
            `Connecté à owserver ${address} : ${read} appareils 1-Wire lus sur ${listed}.`,
          );
    return both(join([head, ...notes], 'en'), join([head, ...notes], 'fr'));
  },
  notes: {
    unread: (items) => {
      const en = items.map((i) => `${i.id} (${reason(i.code, i.errno).en})`);
      const fr = items.map((i) => `${i.id} (${reason(i.code, i.errno).fr})`);
      return both(`Not read: ${list(en)}.`, `Non lus : ${list(fr)}.`);
    },
    powerOn: (ids) =>
      both(
        `85 °C held back (power-on value of a probe that did not convert, check its power supply): ${list(ids)}.`,
        `85 °C retenu (valeur de mise sous tension d’une sonde qui n’a pas converti, vérifiez son alimentation) : ${list(ids)}.`,
      ),
    held: (items) => {
      const text = items.map((h) => `${h.id} ${h.key} ${h.from} → ${h.to}`);
      return both(
        `Counter gone down, held back (click "Accept the counter drops" if it was reset): ${list(text)}.`,
        `Compteur en baisse, retenu (cliquez sur « Accepter les baisses de compteur » s’il a été remis à zéro) : ${list(text)}.`,
      );
    },
    others: (items) => {
      const text = items.map(
        (o) => `${o.model ?? 'family'} ${o.family}${o.count > 1 ? ` ×${o.count}` : ''}`,
      );
      return both(
        `Not supported yet: ${list(text)}.`,
        `Pas encore pris en charge : ${list(text)}.`,
      );
    },
    beyond: (n) =>
      both(
        `${n} more devices are not read (64 at most).`,
        `${n} appareils de plus ne sont pas lus (64 au plus).`,
      ),
    notCreated: (n) =>
      both(
        `${n} devices not created yet in Gladys (Discover tab).`,
        `${n} appareils pas encore créés dans Gladys (onglet Découverte).`,
      ),
    dataUnreadable: both(
      'The /data folder cannot be read: counters are checked only against Gladys, nothing is saved; trying again every 10 s.',
      'Le dossier /data ne peut pas être lu : les compteurs ne sont vérifiés que par rapport à Gladys, rien n’est enregistré ; nouvel essai toutes les 10 s.',
    ),
    dataSlow: both('The /data folder is slow to read.', 'Le dossier /data est lent à lire.'),
  },
  test: {
    notYet: (next) =>
      both(
        `No read yet; the first one in ${delay(next).en}.`,
        `Pas encore de lecture ; la première dans ${delay(next).fr}.`,
      ),
    slow: both(
      'The read takes longer than expected: its result will be in the status.',
      'La lecture prend plus de temps que prévu : son résultat sera dans l’état.',
    ),
    reading: (lines, ago, next, more) => {
      const when = (lang) =>
        ago === undefined
          ? lang === 'en'
            ? 'Read now'
            : 'Lu à l’instant'
          : lang === 'en'
            ? `Read ${delay(ago).en} ago (one read every interval at most)`
            : `Lu il y a ${delay(ago).fr} (une lecture par intervalle au plus)`;
      const body = (lang) =>
        lines.length === 0
          ? lang === 'en'
            ? 'no device'
            : 'aucun appareil'
          : lines.map((l) => l[lang]).join('; ');
      const tail = (lang) =>
        (more > 0 ? ` +${more}` : '') +
        (lang === 'en'
          ? `. Next read in ${delay(next).en}.`
          : `. Prochaine lecture dans ${delay(next).fr}.`);
      return both(
        `${when('en')}: ${body('en')}${tail('en')}`,
        `${when('fr')} : ${body('fr')}${tail('fr')}`,
      );
    },
    accepted: (items) =>
      both(
        `Accepted, published from the next read: ${list(items.map((h) => `${h.id} ${h.key} ${h.to}`))}.`,
        `Accepté, publié dès la prochaine lecture : ${list(items.map((h) => `${h.id} ${h.key} ${h.to}`))}.`,
      ),
    acceptedNotSaved: both(
      'Note: /data could not be written, the acceptance is lost at a restart.',
      'Note : /data n’a pas pu être écrit, l’acceptation est perdue au redémarrage.',
    ),
    nothingHeld: both('No counter is held back.', 'Aucun compteur n’est retenu.'),
  },
};

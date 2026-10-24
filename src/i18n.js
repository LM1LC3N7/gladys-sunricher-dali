// -----------------------------------------------------------------------------
// Names and messages, French and English.
// -----------------------------------------------------------------------------

export const word = (entry, language) => entry?.[language] ?? entry?.en ?? '';

/** An entry whose values are functions -> the entry of their results. */
export const fill = (entry, ...args) =>
  Object.fromEntries(
    Object.entries(entry).map(([lang, value]) => [
      lang,
      typeof value === 'function' ? value(...args) : value,
    ]),
  );

/** Default device names, when the gateway gives none (bus, address). */
export const DEVICE_NAMES = {
  light: { fr: (c, a) => `Luminaire DALI ${c}-${a}`, en: (c, a) => `DALI light ${c}-${a}` },
  motion: {
    fr: (c, a) => `Détecteur de mouvement DALI ${c}-${a}`,
    en: (c, a) => `DALI motion sensor ${c}-${a}`,
  },
  illuminance: {
    fr: (c, a) => `Capteur de luminosité DALI ${c}-${a}`,
    en: (c, a) => `DALI light sensor ${c}-${a}`,
  },
  group: { fr: (c, g) => `Groupe DALI ${c}-${g}`, en: (c, g) => `DALI group ${c}-${g}` },
  scene: { fr: (c, s) => `Scène DALI ${c}-${s}`, en: (c, s) => `DALI scene ${c}-${s}` },
};

export const FEATURE_NAMES = {
  binary: { fr: 'Allumé', en: 'On' },
  brightness: { fr: 'Luminosité', en: 'Brightness' },
  temperature: { fr: 'Température de couleur', en: 'Colour temperature' },
  color: { fr: 'Couleur', en: 'Colour' },
  motion: { fr: 'Mouvement', en: 'Motion' },
  occupancy: { fr: 'Présence', en: 'Occupancy' },
  illuminance: { fr: 'Luminosité ambiante', en: 'Illuminance' },
  activate: { fr: 'Activer la scène', en: 'Activate the scene' },
};

/** Statuses and command messages. */
export const T = {
  noHost: {
    en: 'Enter the IP address of the DALI gateway in the configuration.',
    fr: "Saisissez l'adresse IP de la passerelle DALI dans la configuration.",
  },
  badHost: {
    en: 'The address of the gateway is not understood: an IP address or a name only, without http:// nor port.',
    fr: "L'adresse de la passerelle n'est pas comprise : une adresse IP ou un nom seulement, sans http:// ni port.",
  },
  noSerial: {
    en: 'Enter the serial number of the gateway (shown by the pairing) in the configuration.',
    fr: "Saisissez le numéro de série de la passerelle (affiché par l'appairage) dans la configuration.",
  },
  badSerial: {
    en: 'The serial number is not understood: letters and digits only, as the pairing shows it.',
    fr: "Le numéro de série n'est pas compris : lettres et chiffres seulement, tel que l'appairage l'affiche.",
  },
  noCredentials: {
    en: 'Enter the user name and the password given by the pairing of the gateway.',
    fr: "Saisissez le nom d'utilisateur et le mot de passe donnés par l'appairage de la passerelle.",
  },
  badCredentials: {
    en: 'The user name or the password holds a control character (a paste error?): type them again.',
    fr: "Le nom d'utilisateur ou le mot de passe contient un caractère de contrôle (erreur de copier-coller ?) : saisissez-les à nouveau.",
  },
  badFingerprint: {
    en: 'The certificate fingerprint is not understood: 64 hexadecimal digits (colons allowed).',
    fr: "L'empreinte du certificat n'est pas comprise : 64 chiffres hexadécimaux (deux-points acceptés).",
  },
  connecting: { en: 'Connecting to the DALI gateway…', fr: 'Connexion à la passerelle DALI…' },
  refused: {
    en: 'The gateway refused the user name or the password: no new try. Pair the gateway again (button on the gateway), enter the new credentials, or click "Test the connection".',
    fr: "La passerelle a refusé le nom d'utilisateur ou le mot de passe : aucun nouvel essai. Refaites l'appairage (bouton de la passerelle), saisissez les nouveaux identifiants, ou cliquez sur « Tester la connexion ».",
  },
  certificate: {
    en: (presented, pinned) =>
      `The certificate of the gateway changed (SHA-256 ${presented}, pinned ${pinned}): nothing sent, no new try. If you replaced or reset the gateway, enter the new fingerprint in the configuration.`,
    fr: (presented, pinned) =>
      `Le certificat de la passerelle a changé (SHA-256 ${presented}, épinglé ${pinned}) : rien n'a été envoyé, aucun nouvel essai. Si vous avez remplacé ou réinitialisé la passerelle, saisissez la nouvelle empreinte dans la configuration.`,
  },
  unreachable: {
    en: (reason, seconds) => `DALI gateway unreachable (${reason}); next try in ${seconds} s.`,
    fr: (reason, seconds) =>
      `Passerelle DALI injoignable (${reason}) ; nouvel essai dans ${seconds} s.`,
  },
  reading: {
    en: 'Connected; reading the devices, groups and scenes of the gateway…',
    fr: 'Connecté ; lecture des appareils, groupes et scènes de la passerelle…',
  },
  connected: {
    en: (lights, sensors, groups, scenes, extra) =>
      `Connected to the DALI gateway: ${lights} light(s), ${sensors} sensor(s), ${groups} group(s), ${scenes} scene(s).${extra}`,
    fr: (lights, sensors, groups, scenes, extra) =>
      `Connecté à la passerelle DALI : ${lights} luminaire(s), ${sensors} capteur(s), ${groups} groupe(s), ${scenes} scène(s).${extra}`,
  },
  noAnswer: {
    en: 'Connected, but the gateway does not answer on the topics of this serial number: check the serial number.',
    fr: 'Connecté, mais la passerelle ne répond pas sur les sujets de ce numéro de série : vérifiez le numéro de série.',
  },
  partial: {
    en: (what) => ` Not read: ${what} (no answer in time).`,
    fr: (what) => ` Non lu : ${what} (pas de réponse à temps).`,
  },
  plain: {
    en: ' The user name and password travel in clear on your network (plain MQTT): use TLS if your gateway offers it.',
    fr: ' Le nom d’utilisateur et le mot de passe circulent en clair sur votre réseau (MQTT simple) : utilisez TLS si votre passerelle le propose.',
  },
  offline: {
    en: 'Not connected to the DALI gateway: nothing sent.',
    fr: 'Pas connecté à la passerelle DALI : rien n’a été envoyé.',
  },
  tooLate: {
    en: 'The command could not leave in time: nothing sent.',
    fr: 'La commande n’a pas pu partir à temps : rien n’a été envoyé.',
  },
  unknownDevice: {
    en: 'This device is not (or no longer) known by the gateway: nothing sent. Click "Scan" in the Discovery tab.',
    fr: 'Cet appareil n’est pas (ou plus) connu de la passerelle : rien n’a été envoyé. Cliquez sur « Scanner » dans l’onglet Découverte.',
  },
  readOnly: {
    en: 'This feature is read only: nothing sent.',
    fr: 'Cette fonctionnalité est en lecture seule : rien n’a été envoyé.',
  },
  badValue: {
    en: (value) => `Value not understood (${value}): nothing sent.`,
    fr: (value) => `Valeur non comprise (${value}) : rien n’a été envoyé.`,
  },
  stillConnecting: {
    en: 'Still connecting to the gateway: look at the status in a few seconds.',
    fr: 'Connexion à la passerelle toujours en cours : regardez l’état dans quelques secondes.',
  },
  stillReading: {
    en: 'Connected; the gateway is still sending its devices: look at the status in a few seconds.',
    fr: 'Connecté ; la passerelle envoie encore ses appareils : regardez l’état dans quelques secondes.',
  },
};

export const COMMAND_NAMES = {
  power: {
    en: (id, on) => `${id} ${on ? 'on' : 'off'}`,
    fr: (id, on) => `${id} ${on ? 'allumé' : 'éteint'}`,
  },
  brightness: {
    en: (id, v) => `${id} brightness ${v} %`,
    fr: (id, v) => `${id} luminosité ${v} %`,
  },
  temperature: {
    en: (id, v) => `${id} colour temperature ${v} K`,
    fr: (id, v) => `${id} température de couleur ${v} K`,
  },
  color: { en: (id, v) => `${id} colour #${v}`, fr: (id, v) => `${id} couleur #${v}` },
  scene: { en: (id) => `scene ${id}`, fr: (id) => `scène ${id}` },
};

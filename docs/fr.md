# owserver (1-Wire) pour Gladys Assistant

Connecteur non officiel, sans lien avec le projet OWFS. Il lit les appareils
1-Wire servis par un **owserver** (le serveur réseau d'OWFS) qui tourne sur
votre réseau, par son protocole TCP (port 4304), sans cloud.

Testé contre owserver en mode adaptateur simulé (`owserver --fake`), jamais
testé avec un vrai bus 1-Wire : dites-nous comment il se comporte avec le vôtre.

## Ce que vous obtenez

Un appareil Gladys par appareil 1-Wire listé à la racine d'owserver, repéré par
son identifiant ROM (par exemple `28-4AEC29CDBAAB`) : une nouvelle adresse de
l'owserver, ou la sonde déplacée sur un autre bus, garde son appareil et son
historique.

| Famille            | Puce                                       | Fonctions                        |
| ------------------ | ------------------------------------------ | -------------------------------- |
| 10, 22, 28, 3B, 42 | DS18S20, DS1822, DS18B20, DS1825, DS28EA00 | Température (°C)                 |
| 26                 | DS2438                                     | Température (°C)                 |
| 1D                 | DS2423                                     | Compteur A, Compteur B           |
| 05, 12, 3A, 29     | DS2405, DS2406, DS2413, DS2408             | Entrées, en capteurs d'ouverture |

Les autres familles (DS2450, concentrateurs DS2409, capteurs EDS…) sont
nommées dans l'état comme « pas encore prises en charge ». Les appareils
derrière un concentrateur DS2409 ne sont pas lus.

Lecture seule : seules des demandes de liste et de lecture partent, rien n'est
jamais écrit sur le bus. Les sorties des interrupteurs (DS2406, DS2408,
DS2413) viendront plus tard.

## Préparer owserver

owserver doit écouter sur le réseau, pas seulement sur localhost. Dans
`/etc/owfs.conf` de la machine qui porte l'adaptateur 1-Wire :

```
server: usb = all          # ou : server: i2c = ALL:ALL pour un DS2482
server: port = 0.0.0.0:4304
```

puis redémarrez owserver. Vérifiez depuis une autre machine avec
`owdir -s 192.168.1.30:4304 /`.

## Configuration

- **Adresse de l'owserver** : son adresse IP ou son nom d'hôte, avec un port
  seulement s'il n'est pas 4304.
- **Intervalle de lecture** : 30 s, 1 min (par défaut), 2 ou 5 min. Avec
  beaucoup d'appareils, l'intervalle est allongé pour qu'une lecture complète
  reste sous 250 valeurs par minute (64 appareils lus au plus).

Ouvrez ensuite l'onglet **Découverte** et créez les appareils voulus.

## Comment les valeurs sont vérifiées

- Les températures sont demandées en Celsius quel que soit le réglage
  d'owserver. Une valeur hors de -55 à +125 °C, ou un texte qui n'est pas un
  nombre, n'est pas publiée.
- **85 °C** est la valeur d'une DS18x20 qui n'a pas converti (une coupure
  d'alimentation, une sonde en alimentation parasite qui l'a perdue) : elle est
  retenue, sauf si la température précédente de cette sonde en était à moins de
  10 °C. L'état nomme la sonde ; vérifiez son alimentation.
- Les **compteurs** (DS2423) ne baissent jamais dans Gladys : une valeur plus
  basse (un compteur sans pile repart de 0 après une coupure de courant) est
  retenue et l'état le dit. Quand elle est juste, cliquez sur **Accepter les
  baisses de compteur** : chaque compteur retenu prend sa valeur plus basse
  comme nouveau départ, publiée dès la lecture suivante. Enregistrer la
  configuration ne le fait jamais.
- **Entrées** : owserver donne le niveau de la broche. Une broche tirée au
  niveau bas (un contact fermé à la masse) s'affiche **fermée**, une broche au
  niveau haut (un contact ouvert, avec sa résistance de rappel) **ouverte**.
- Un appareil en échec (parti du bus, erreur de bus, valeur illisible) laisse
  seulement cet appareil non lu ; l'état le nomme. Un tour de lecture ne commence
  plus d'appareil après 60 s : les appareils restants sont lus en premier la
  fois suivante.

## Boutons

- **Tester la connexion** : lit l'owserver une fois quand une lecture est due
  (jamais plus d'une par intervalle), sinon donne la dernière lecture.
- **Accepter les baisses de compteur** : voir plus haut.

## Messages d'état

L'écran de configuration montre l'adresse, le nombre d'appareils lus, et des
notes : appareils non lus (et pourquoi), 85 °C retenu, compteurs retenus,
familles pas encore prises en charge, appareils pas créés dans Gladys, dossier
`/data` illisible (les compteurs ne sont alors vérifiés que par rapport aux
valeurs que Gladys garde et rien n'est enregistré ; nouvel essai toutes les
10 s).

## Vie privée et sécurité

owserver n'a pas d'identifiants : rien de secret n'est configuré, gardé ni
journalisé. L'intégration ne garde dans son dossier `/data` que l'heure de la
dernière lecture, les identifiants ROM vus et les valeurs des compteurs.

OWFS est distribué sous GPL 2.0 ; cette intégration n'en contient aucun code et
parle seulement à owserver par le réseau (voir `THIRD_PARTY_NOTICES.md`).

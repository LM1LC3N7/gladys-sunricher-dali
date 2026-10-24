# Sunricher DALI pour Gladys Assistant

Cette intégration relie Gladys aux **passerelles DALI Sunricher** (SR-GW-EDA,
configurée avec l'application DALI Center) **en local**, par le serveur MQTT
intégré à la passerelle : pas de cloud, pas d'autre broker à installer.

> **Jamais testée avec une vraie passerelle.** Le protocole est repris de la
> bibliothèque PySrDaliGateway (Sunricher, Apache-2.0), utilisée par Home
> Assistant. Non officiel, sans lien avec Sunricher.

## Ce que fait l'intégration

À chaque connexion, et quand vous cliquez sur « Scanner » (une fois par minute
au plus), elle lit la liste que la passerelle tient déjà (elle ne lance jamais
de recherche sur le bus DALI) :

- **Luminaires DALI** : allumage, luminosité, et selon le type DALI la
  température de couleur (DT8 Tc) ou la couleur (DT8 RGB, XY, RGBW, RGBWA).
- **Groupes DALI** : allumage et luminosité du groupe. La passerelle ne donne
  pas d'état propre au groupe : Gladys affiche « allumé » si un membre est
  allumé, « éteint » si tous le sont (inconnu tant qu'un membre est inconnu).
- **Scènes** : un bouton « Activer la scène » par scène de la passerelle. Les
  scènes se créent et se modifient dans DALI Center.
- **Détecteurs de mouvement** : mouvement (instantané) et présence (reste
  active jusqu'à « zone libre »).
- **Capteurs de luminosité** : lux (valeurs de 0 à 1000 ; une valeur hors de
  cette plage est ignorée).
- **Boutons poussoirs DALI-2** : pas d'appareil, mais un **déclencheur de
  scène** « Bouton poussoir DALI » (bouton, numéro de touche, événement :
  appuyé, maintenu, appuyé deux fois, tourné, relâché).

Les états arrivent en temps réel (la passerelle les envoie). Pas encore pris en
charge : la consommation d'énergie des luminaires, l'identification
(clignotement), les réglages des capteurs et des drivers.

## 1. Appairage : obtenir les identifiants de la passerelle

La passerelle ne donne son **nom d'utilisateur** et son **mot de passe** MQTT
qu'après un appui sur son bouton, en réponse à une demande envoyée sur le
réseau local en multidiffusion UDP. Le conteneur d'une intégration Gladys ne
voit pas la multidiffusion du réseau (pont Docker) : l'appairage se fait donc
**une fois**, par une petite commande sur la machine de Gladys (ou tout
ordinateur du même réseau avec Node.js 22 ou plus) :

```bash
docker run --rm -it --network host ghcr.io/lm1lc3n7/gladys-sunricher-dali:<version> node scripts/pair.mjs
```

(remplacez `<version>` par la version installée, affichée dans Gladys ; depuis
une copie du dépôt : `node scripts/pair.mjs`).

1. Lancez la commande : elle cherche les passerelles pendant 3 minutes.
2. Appuyez **une fois, brièvement**, sur le bouton **Reset** de la passerelle.
3. La commande affiche l'**adresse**, le **port MQTT**, le **numéro de série**,
   le **nom d'utilisateur**, le **mot de passe** et si la passerelle utilise
   **TLS**.
4. Recopiez ces valeurs dans la configuration de l'intégration, puis effacez
   le terminal : le mot de passe n'est affiché que là (jamais écrit dans un
   fichier ni dans un journal).

Options : `--serial <numéro>` (seulement cette passerelle), `--timeout
<secondes>`. Si plusieurs passerelles répondent, la première avec des
identifiants est affichée : relancez avec `--serial` pour les autres.

La demande et la réponse sont brouillées avec une clé fixe publiée dans
PySrDaliGateway : c'est une convention du protocole de la passerelle, pas une
protection. Le champ `type: "HA"` de la demande est celui de la bibliothèque du
fabricant pour les box domotiques tierces.

## 2. Configuration

- **Adresse de la passerelle** : son adresse IP (donnez-lui une adresse fixe
  dans votre box).
- **Port MQTT** : celui affiché par l'appairage (1883 par défaut).
- **Numéro de série** : tel qu'affiché (sur la SR-GW-EDA, l'adresse MAC en
  majuscules sans séparateurs ; `A1:B2:…` est accepté). Il fait partie des
  sujets MQTT : l'intégration ne prend que les messages de **ce** numéro de
  série, et ignore un message qui annonce un autre numéro.
- **Nom d'utilisateur** et **mot de passe** : ceux de l'appairage. Le mot de
  passe est gardé par Gladys dans sa base, jamais réaffiché, envoyé seulement à
  la passerelle, jamais écrit dans les journaux.
- **TLS** : seulement si l'appairage indique `TLS: yes`.
- **Empreinte du certificat** (TLS seulement, facultatif) : vide, le premier
  certificat vu est épinglé et gardé dans `/data` **avant** l'envoi du mot de
  passe.
- **Langue des noms** : pour les appareils sans nom dans la passerelle.

Le bouton **Tester la connexion** tente une connexion (si aucune n'est en
cours) et affiche ce qui a été lu.

## Sécurité et limites

- **Sans TLS** (fonctionnement par défaut de la passerelle), le nom
  d'utilisateur et le mot de passe circulent **en clair** sur votre réseau
  local : l'état de l'intégration le rappelle. Avec TLS, le certificat est
  épinglé ; s'il change, **rien n'est envoyé**, la connexion s'arrête sans
  nouvel essai et l'état affiche les deux empreintes. Si vous avez remplacé ou
  réinitialisé la passerelle, saisissez la nouvelle empreinte. Vider le champ
  ne fait pas réapprendre un certificat.
- **Identifiants refusés** (réponse 4 ou 5 de la passerelle, ou deux
  connexions de suite fermées juste après l'envoi des identifiants) : arrêt
  gardé dans `/data`, **aucun nouvel essai**, même après un redémarrage. Il se
  lève en changeant la configuration (nouveaux identifiants après un nouvel
  appairage), ou par « Tester la connexion » une fois qu'une connexion réussit.
- **Une seule session MQTT** à la fois ; reconnexions espacées de 10 s, 30 s,
  1 min, 2 min puis 5 min ; un conteneur qui redémarre en boucle se connecte
  au plus une fois par 10 s (heure de la tentative gardée dans `/data`).
- **Messages bornés** : 512 Ko au plus par message, listes et noms bornés,
  1 000 messages par 10 s au plus ; un message mal formé ou d'un autre numéro
  de série est ignoré.
- **Nombreux luminaires** : les commandes de même nature envoyées en moins de
  100 ms partent dans un seul message MQTT (32 appareils par message) ; Gladys
  reçoit au plus 240 états par minute, luminaires et détecteurs de mouvement
  d'abord ; une valeur inchangée n'est renvoyée que toutes les 30 minutes.

## Commandes

Une commande est **acquittée quand elle est écrite vers la passerelle** ; le
luminaire (ou les membres du groupe, ou les luminaires du bus après une scène)
est relu 1,5 s plus tard et Gladys reçoit l'état réel. Une commande est
**refusée, rien n'est envoyé**, exactement dans ces cas :

- l'intégration n'est pas connectée à la passerelle, ou la connexion s'est
  coupée avant l'écriture du message ;
- la commande n'a pas pu partir dans les 3,5 s ;
- l'appareil n'est pas (ou plus) dans la liste lue de la passerelle, ou
  appartient à une autre passerelle ;
- la valeur n'est pas comprise (allumage autre que 0 ou 1, luminosité hors de
  0 à 100, température hors de 153 à 500 mired, couleur hors de 0 à 16777215,
  scène autre que 1, valeur vide) ;
- la fonctionnalité est en lecture seule (capteurs).

Une luminosité au-dessus de 0 allume aussi le luminaire ; 0 l'éteint.

## Identifiants externes

Règle figée (elle fixe les appareils, leur historique et vos scènes) :
`light:<série>-<bus>-<adresse>`, `motion:…`, `illuminance:…`,
`group:<série>-<bus>-<groupe>`, `scene:<série>-<bus>-<scène>`, avec le numéro
de série en minuscules, le bus DALI (canal) et l'adresse courte DALI. Changer
l'adresse DALI d'un driver crée un nouvel appareil dans Gladys.

## Dépannage

- **« Connecté, mais la passerelle ne répond pas sur les sujets de ce numéro
  de série »** : vérifiez le numéro de série (celui de l'appairage).
- **Injoignable** : vérifiez l'adresse IP et le port ; un pare-feu de l'hôte
  peut bloquer le trafic du pont Docker vers le réseau local.
- **Un luminaire manque** : il doit être ajouté à la passerelle dans DALI
  Center, puis « Scanner » dans l'onglet Découverte.

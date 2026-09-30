## 2. Proiektuaren egitura eta Espezifikazioa

### 2.1 Proiektuaren egitura
**B aukera (Egitura modularra)** hautatu dugu. Egitura honi esker, iturburu-kode guztia `src` karpetan kapsulatuta geratzen da, eta proiektuaren erroa garbi mantentzen dugu, soilik ezinbesteko konfigurazio-fitxategiak (adibidez, `.env` edo `package.json`) bertan utziz. Planteamendu hau Node.js garapen moderno eta profesionalean estandarra da.

### 2.2 Zerbitzariaren sarrera-puntua
**B aukera** hartu dugu. A aukera ezin dugu aukeratu, ez dugulako Express Generator-en egitura erabili, beraz, ez du zentzurik A aukera hartzea goian ez badugu egitura tradizionala aukeratu. Beraz, B edo C izango lirateke geratzen diren aukerak. Guk **B aukeratu dugu** txukunago geratzen delako alde batetik zerbitzariaren "konfigurazioa" (`app.js`) eta bestetik zerbitzaria abiarazten duen fitxategia izanda (`server.js`).

### 2.3 Karpeten antolaketa
**A aukera** aukeratu dugu. C aukera (hibridoa) baztertu dugu, gure ustez antolaketa nahasgarria izan daitekeelako garapen fase honetan. B aukera (moduluka) ere ez dugu beharrezko ikusi, proiektuak ez baitu modulu kopuru handirik. **A aukera** hautatu dugu sinpleena eta argiena delako talde-lanerako.

### 2.4 Konfigurazioaren kudeaketa
**B aukera** hautatu dugu. Horrela, konfigurazioa fitxategi bakar batean zentralizatzen dugu. Honek segurtasuna eta sendotasuna ematen dio proiektuari: `.env` fitxategian edozein aldagai falta bada edo gaizki badago, aplikazioak hasieraketan bertan emango du errorea.

---

### 2.5. Espezifikazioa: Sistemaren ibilbideak

Hemen dituzu zure datuak taula formatu garbian, README fitxategian txertatzeko prest:

#### 1. Orrialde Nagusia (`index.js`)

| Metodoa | Ibilbidea | Deskribapena | Baimena |
| :--- | :--- | :--- | :--- |
| `GET` | `/` | Home orrialdea kargatzeko | Denek |
| `GET` | `/play` | Jolasten hasteko orrialdea kargatzeko | Denek |

#### 2. Autentifikazio Ibilbideak (`/auth/*`)

| Metodoa | Ibilbidea | Deskribapena | Baimena |
| :--- | :--- | :--- | :--- |
| `GET` | `/auth/login` | Login orrialdea kargatzeko | Denek |
| `GET` | `/auth/register` | Register orrialdea kargatzeko | Denek |
| `GET` | `/auth/google` | Autentifikazioa Google-rekin egiteko (OAuth) | Denek |
| `GET` | `/auth/github` | Autentifikazioa Github-ekin egiteko (OAuth) | Denek |
| `POST` | `/auth/logout` | Saioa ixteko eskaera | Login eginda |
| `POST` | `/auth/login` | Login egiteko eskaera bidaltzeko | Denek |
| `POST` | `/auth/register` | Register egiteko eskaera bidaltzeko | Denek |
| `GET` | `/auth/google/callback` | Google OAuth callback-a jaso eta login konprobatu | Denek |
| `GET` | `/auth/github/callback` | Github OAuth callback-a jaso eta login konprobatu | Denek |

#### 3. API REST (`/api/*`)

| Metodoa | Ibilbidea | Deskribapena | Baimena |
| :--- | :--- | :--- | :--- |
| `GET` | `/api/players` | Jokalari guztien zerrenda lortu | Denek |
| `GET` | `/api/players/:id` | Jokalari zehatz baten datuak lortu | Denek |
| `POST` | `/api/players` | Jokalari berri bat sortu datu-basean | Admin |
| `PUT` | `/api/players/:id` | Jokalari baten datuak eguneratu | Admin |
| `DELETE` | `/api/players/:id` | Jokalari bat sistematik ezabatu | Admin |
| `GET` | `/api/teams` | Talde guztien zerrenda lortu | Denek |
| `GET` | `/api/leagues` | Liga guztien zerrenda lortu | Denek |
| `GET` | `/api/solution/:gameNumber` | *gameNumber* partidako soluzioa lortu | Denek |
| `POST` | `/api/solution/create/:gameNumber` | Soluzio bat sortu *gameNumber* batentzat (esleitu playerId) | Denek |
| `PATCH` | `/api/solution/repair/:gameNumber` | Soluzio korruptoa bada (ez da existitzen), berri bat eguneratu | Denek |
| `GET` | `/api/game/alltries` | Jokalariak egindako saiakera guztiak lortu | Login eginda |
| `POST` | `/api/game/stats/create` | Sortu estatistikak logeatuta dagoen jokalariarentzat | Login eginda |
| `GET` | `/api/game/stats` | Lortu logeatuta dagoen jokalariaren estatistikak | Login eginda |
| `GET` | `/api/game/:gameNumber` | Lortu erabiltzailearen *gameNumber* partidako saiakera | Login eginda |
| `POST` | `/api/game/:gameNumber/guess` | Saiakera gehitu/eguneratu eta partida amaitu bada estatistikak eguneratu | Login eginda |
| `GET` | `/api/isLoggedIn` | Konprobatu erabiltzailea logeatuta dagoen edo ez | Denek |

#### 4. Administrazio Panela (`/admin/*`)

| Metodoa | Ibilbidea | Deskribapena | Baimena |
| :--- | :--- | :--- | :--- |
| `GET` | `/admin` | Jokalarien zerrenda ikusteko panela | Admin |
| `GET` | `/admin/players/new` | Jokalari berria sortzeko formularioa erakutsi | Admin |
| `GET` | `/admin/players/edit/:id` | Jokalaria editatzeko formularioa erakutsi | Admin |

npm install egitean---> deskargatu argazkiak eta populatu db-an datuak
npm run seed---> datu basean populatu datuak
npm run setup --> argazkiak deskargatu.
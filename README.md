# Business Ledger

Chhote business ke liye poora management system: **Income, Expenses, Customers (udhaar / balance), Bound money**,
photo/screenshot/audio attachments, print-able customer statement, CSV export, aur backup/restore.
Phone par app ki tarah chalta hai.

## Dashboard ke numbers ka matlab (zaroor padho)
| Card | Matlab |
|---|---|
| **Money In** | Other Income + customers se mila hua paisa (payments) |
| **Net** | Money In − Expenses |
| **Customers Owe You (today)** | Sab customers ka *abhi tak ka* baqaya (period se independent) |
| **Bound Money Pending (today)** | Jo paisa aapne customer ke item/material par lagaya aur abhi wapas nahi mila |

- Customer se paisa **Customers → Add Sale / Add Payment** se likho. Isay **Income** page par dobara mat likhna,
  warna double count hoga. Income page sirf *doosri* aamdani (scrap, refund, owner capital...) ke liye hai.
- Customer ne zyada de diya to "Advance" likha aata hai.
- **Return (saman wapis):** Customer kholo → **Add Return** → items, quantity, wajah, photo, aur wapis aaye saman ki value likho.
  Ye value customer ke total bill se **minus** ho jati hai: Balance = Sales − Returns − Payments.
  Agar customer ne pehle hi paise de diye the, to balance "Advance" ban jata hai (aapko usay wapis dene hain ya agle bill mein adjust karna hai).
- **Delete:** customer page par har transaction (Sale / Payment / Return) ke saath **Delete** button hai. Sale delete karne par uske saath mila hua payment bhi hat jata hai.
  Sale ke saath mila hua payment akele delete karo to wo sale "kuch nahi mila" ban jati hai.

## Hosting: kya chunein?
| | Kaisa hai |
|---|---|
| **Netlify** (recommended) | Free plan mein 300 credits/month. Business use allowed. Limit paar ho to site mahine ke end tak pause hoti hai (data safe rehta hai). |
| **Render** | Hamesha-chalta Node server, `npm start`. Free plan sleep karta hai (pehli request 30-60s). |
| **Vercel** | ⚠️ Free "Hobby" plan **sirf non-commercial** use ke liye hai. Business ke liye Vercel Pro ($20/mo) chahiye. Isliye Netlify chuno. |

Database: **Neon Postgres (recommended)** — free, 10 MB tak attachments, aur Firestore ki tarah "reads" ka quota nahi.
Firestore bhi chalta hai (README ke neeche), lekin attachment 700 KB tak.

---

## DEPLOY — Netlify + Neon (~15 minute)

### 1. Database (Neon)
1. https://neon.tech par account banao → **Create project**
2. **Connection string** copy karo (`postgresql://...neon.tech/neondb?sslmode=require`).

### 2. Code GitHub par
1. GitHub par **private** repo banao.
2. Is folder ki **andar ki saari files** repo ke **root** mein upload karo (`package.json`, `server.js`, `netlify.toml`,
   `public/`, `netlify/`, `api/` sab seedhe root mein). `node_modules`, `data`, `.env` upload NAHI karni.

### 3. Netlify
1. https://app.netlify.com → **Add new site → Import an existing project** → repo chuno.
2. Build settings `netlify.toml` se khud aa jati hain, kuch mat badlo.
3. **Site configuration → Environment variables** mein daalo:

| Name | Value |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | Neon wali string |
| `ADMIN_USERNAME` | jaise `owner` |
| `ADMIN_PASSWORD` | **mazboot** password (12+ characters) |
| `SESSION_SECRET` | koi lambi random string (40+ characters) |
| `MAX_UPLOAD_MB` | `4` |

4. **Deploy site**. 1-2 minute mein `https://xxxx.netlify.app` mil jayega.
5. Link kholo → login → **Settings** page par "PostgreSQL (permanent)" likha hona chahiye. Ye confirm karta hai ke data permanent save ho raha hai.
6. Optional: Netlify → **Domain management** se apna naam (e.g. `babaledger.netlify.app`) rakh lo.

### 4. Pehli baar test (5 minute, zaroor karo)
1. Ek customer banao → Add Sale (Total 1000, Received 400) → customer page par balance **Rs 600** aana chahiye.
2. Ek photo attach karke Expense save karo, phir refresh karke photo dikhe.
3. Settings → **Download backup** chalao.
4. Phone par kholo → **Add to Home Screen**.

## Vercel par (sirf agar Vercel Pro hai)
Vercel → **Add New Project** → repo chuno → wahi environment variables → Deploy. (`api/[...slug].js` aur `vercel.json` pehle se tayyar hain.)
`MAX_UPLOAD_MB` 4 se kam rakho (Vercel ki request limit 4.5 MB hai).

## Render par
New → Web Service → repo → Build `npm install`, Start `npm start`, wahi environment variables.

## Firestore use karna ho to
Firebase Console → Firestore create → Project settings → Service accounts → **Generate new private key** → poori JSON ek line mein
`FIREBASE_SERVICE_ACCOUNT` mein paste karo (aur `DATABASE_URL` mat daalo — dono ek saath nahi chalte).
Dhyan: Firestore free plan mein roz ~50,000 reads hain aur ye app data load karte waqt sab records padhta hai; ledger bada hone par
Neon behtar rahega.

---

## Roz ka istemal — tips
- **Backup:** Settings → *Download backup* — hafte mein ek baar (ya har mahine ke end par). Ye entries ki file hai (attachment files nahi).
- **Restore:** Settings → *Restore from backup*. Purani entries nahi badalti, sirf gayab wali wapas add karti hai.
- **Customer statement:** customer kholo → **Print Statement** (phone par "Save as PDF" bhi ho jata hai) — customer ko dikhane ke liye.
- **Excel:** Income / Expenses / Bound / Customers pages par **Export CSV** (customers ki CSV mein Returns ka column bhi hai).
- **Bound:** jab paisa wapas mil jaye to entry kholo, Status ko **Recovered** karo.
- **Password badalna:** Netlify mein `ADMIN_PASSWORD` badlo aur redeploy karo. Sab devices dobara login maangenge.
- Login par 10 galat koshishon ke baad 15 minute ke liye block ho jata hai.

## Jo cheezein is version mein NAHI hain (seedhi baat)
- Sirf **ek user** (owner). Multi-user / staff accounts nahi.
- Logout sirf us device ka cookie hatata hai; agar phone kho jaye to password (`ADMIN_PASSWORD`) ya `SESSION_SECRET` badal do — sab session khatam.
- App offline nahi chalti (internet chahiye).
- Sirf Pakistani Rupee (Rs).
- Backup file mein attachment photos/audio nahi hoti; wo database mein rehti hain.

## Apne computer par chalana
Node.js 22.5+ chahiye (bina database ke local test file ke liye).
```
npm install
cp .env.example .env     # DATABASE_URL (ya khali chhod ke local file) aur ADMIN_PASSWORD bhar do
npm run dev              # http://localhost:3000
npm test                 # automatic tests
```

## Environment variables
| Name | Zaroori? | Matlab |
|---|---|---|
| `DATABASE_URL` | in dono mein se ek (production) | Postgres connection string |
| `FIREBASE_SERVICE_ACCOUNT` | ⤴ | Firestore service-account JSON (ek line) |
| `ADMIN_PASSWORD` | haan | login password (production mein 8+ characters) |
| `ADMIN_USERNAME` | nahi | default `admin` |
| `SESSION_SECRET` | sifarish | login cookie sign karne ki lambi random string |
| `MAX_UPLOAD_MB` | nahi | har attachment ki max size (Netlify/Vercel par 4) |
| `MAX_STORAGE_MB` | nahi | kul attachments limit (default 400 Postgres / 800 Firestore) |
| `DATABASE_SSL` | nahi | `false` sirf tab jab Postgres SSL na use kare |

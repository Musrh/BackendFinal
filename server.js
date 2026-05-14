================================================================
  GUIDE D'INTÉGRATION BACKUP & RESTORE DANS server.js
  SaasBuilder — Backend Railway (ESM)
================================================================

server.js utilise les modules ES (import/export).
backup.js et store-restore.js utilisent CommonJS (require).
→ Un pont createRequire est nécessaire (Option B recommandée).

================================================================
  ÉTAPE 1 — Ajouter le pont ESM/CJS en haut de server.js
================================================================

Juste après les imports existants (après la ligne "import cron..."),
ajouter ces 4 lignes :

─────────────────────────────────────────────────────────────────
import { createRequire } from "module"
const require = createRequire(import.meta.url)

const { backupRoutes }       = require("./backup.js")
const { storeRestoreRoutes } = require("./store-restore.js")
─────────────────────────────────────────────────────────────────

Résultat attendu en haut de server.js :

  import express    from "express"
  import cors       from "cors"
  import Stripe     from "stripe"
  import dotenv     from "dotenv"
  import admin      from "firebase-admin"
  import bodyParser from "body-parser"
  import Groq       from "groq-sdk"
  import cron       from "node-cron"
  import { createRequire } from "module"          ← AJOUTER
  const require = createRequire(import.meta.url)  ← AJOUTER

  const { backupRoutes }       = require("./backup.js")        ← AJOUTER
  const { storeRestoreRoutes } = require("./store-restore.js") ← AJOUTER


================================================================
  ÉTAPE 2 — Enregistrer les routes dans app
================================================================

Chercher dans server.js la zone juste avant app.listen().
Ajouter ces 2 lignes à cet endroit :

─────────────────────────────────────────────────────────────────
// ── Backup & Restore ──────────────────────────────────────────
backupRoutes(app)        // /api/admin/backup, /api/admin/backups, /api/admin/restore
storeRestoreRoutes(app)  // /api/store/backups, /api/store/restore
─────────────────────────────────────────────────────────────────

Exemple de placement dans server.js :

  // ... toutes les autres routes existantes ...

  backupRoutes(app)        // ← AJOUTER
  storeRestoreRoutes(app)  // ← AJOUTER

  app.listen(PORT, () => {
    console.log(`✅ Serveur démarré sur le port ${PORT}`)
  })


================================================================
  ÉTAPE 3 — Variables d'environnement Railway
================================================================

Dans le tableau de bord Railway → votre service backend → Variables :

  BACKUP_BUCKET=saasbuilder-backups     ← nom du bucket GCS
  BACKUP_RETENTION_DAYS=30              ← rétention en jours

  FIREBASE_SERVICE_ACCOUNT  (déjà présent — même valeur)

Note : le bucket Google Cloud Storage doit exister avant le
premier backup. Créez-le dans la console GCP (console.cloud.google.com)
→ Cloud Storage → Créer un bucket, avec le même nom que BACKUP_BUCKET,
dans la même région que votre projet Firebase.

Permissions IAM requises pour le service account Firebase :
  - Storage Object Admin  (roles/storage.objectAdmin)


================================================================
  ÉTAPE 4 — Installer @google-cloud/storage
================================================================

Dans le dossier de votre backend (là où se trouve server.js) :

  npm install @google-cloud/storage

Redéployez sur Railway après l'installation.


================================================================
  ÉTAPE 5 — Backup automatique (cron) dans server.js
================================================================

Un cron node-cron est déjà importé dans server.js.
Ajouter le job suivant AVANT app.listen() :

─────────────────────────────────────────────────────────────────
// Backup Firestore automatique : tous les jours à 2h00 UTC
cron.schedule("0 2 * * *", async () => {
  console.log("[cron] Démarrage backup automatique Firestore...")
  try {
    const { exportToJson, uploadToStorage, cleanOldBackups } = require("./backup.js")
    const fs = require("fs")
    const { filename, filepath } = await exportToJson()
    await uploadToStorage(filepath, filename)
    await cleanOldBackups()
    fs.unlinkSync(filepath)
    console.log(`[cron] ✅ Backup OK : ${filename}`)
  } catch (e) {
    console.error("[cron] ❌ Backup échoué :", e.message)
  }
})
─────────────────────────────────────────────────────────────────

Note : exportToJson, uploadToStorage et cleanOldBackups sont déjà
exportés par backup.js (voir module.exports en bas du fichier).


================================================================
  FICHIERS À DÉPLOYER SUR RAILWAY
================================================================

Copier ces 3 fichiers dans le même dossier que server.js :

  backup.js         ← fourni dans backup.js.txt
  store-restore.js  ← fourni dans store-restore.js.txt
  server.js         ← modifié selon les étapes 1, 2 et 5


================================================================
  RÉCAPITULATIF DES ROUTES CRÉÉES
================================================================

ADMIN (musmamon@gmail.com / musrh@gmail.com uniquement) :

  POST /api/admin/backup
    Body  : { idToken }
    Retour: { success, filename }
    → Déclenche un backup manuel de toutes les collections.

  GET  /api/admin/backups?idToken=...
    Retour: { backups: [{ filename, size, createdAt }], count }
    → Liste les 30 derniers backups.

  GET  /api/admin/backup/:filename?idToken=...
    → Télécharge un backup complet (stream JSON).

  POST /api/admin/restore
    Body  : { idToken, filename, dryRun, overwrite, collections }
    Retour: { success, dryRun, restored, skipped, errors }
    → Restaure toutes les collections (dryRun=true par défaut).

PROPRIÉTAIRE DE STORE (tout compte Firebase authentifié) :

  GET  /api/store/backups?idToken=...
    Retour: { backups: [{ filename, size, createdAt }], count }
    → Liste les backups disponibles.

  POST /api/store/restore
    Body  : { idToken, filename, dryRun }
    Retour: { success, dryRun, uid, filename, restored, skipped, detail }
    detail: { userData, orders, forders, slugs, prodinfos }
    → Restaure UNIQUEMENT les données de l'utilisateur connecté :
        users/{uid}                          (profil)
        orders   où ownerUid === uid         (commandes Pro)
        forders  où ownerUid === uid         (commandes Free)
        slugs    où uid === uid              (slugs publiés)
        prodinfos où ownerUid === uid        (infos produits)
    ✅ Aucune donnée d'un autre utilisateur n'est jamais touchée.

================================================================
  FLUX COMPLET — SCÉNARIO TYPIQUE
================================================================

1. Backup automatique à 2h00 → GCS bucket "saasbuilder-backups"
   Rétention : 30 jours, puis suppression automatique.

2. Admin déclenche un backup manuel depuis Admin.vue (bouton ☁️).
   → POST /api/admin/backup → le fichier apparaît dans la liste.

3. Admin simule une restauration globale (🔍 Simuler dans Admin.vue).
   → POST /api/admin/restore { dryRun: true }
   → Réponse : nombre de docs qui seraient restaurés/ignorés.

4. Admin confirme la restauration réelle (modal de confirmation).
   → POST /api/admin/restore { dryRun: false, overwrite: true }

5. Propriétaire de store consulte ses backups (Dashboard.vue).
   → GET /api/store/backups → liste des fichiers disponibles.

6. Propriétaire simule la restauration de ses données (🔍 Simuler).
   → POST /api/store/restore { dryRun: true }
   → Détail par collection affiché dans le panneau.

7. Propriétaire confirme la restauration (modal + bouton Confirmer).
   → POST /api/store/restore { dryRun: false }
   → userData et commandes rechargés automatiquement côté Vue.

================================================================

// ================================================================
//  check-bucket.js — Vérification accès Google Cloud Storage
//  Usage : node check-bucket.js
//  À exécuter UNE FOIS avant le premier déploiement pour valider
//  que le compte de service a bien accès au bucket de backup.
// ================================================================

const { Storage } = require("@google-cloud/storage")
require("dotenv").config()

// ── Config ───────────────────────────────────────────────────────
const BUCKET_NAME = process.env.BACKUP_BUCKET || "saasbuilder-backups"

let SERVICE_ACCOUNT
try {
  SERVICE_ACCOUNT = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
} catch (e) {
  console.error("❌ FIREBASE_SERVICE_ACCOUNT invalide ou absent")
  console.error("   Vérifiez que le fichier .env est présent et que la variable est un JSON valide.")
  process.exit(1)
}

const storage = new Storage({ credentials: SERVICE_ACCOUNT })

// ── Utilitaires ──────────────────────────────────────────────────
const ok  = (msg) => console.log(`  ✅ ${msg}`)
const err = (msg) => console.error(`  ❌ ${msg}`)
const inf = (msg) => console.log(`  ℹ️  ${msg}`)

// ── Tests ────────────────────────────────────────────────────────

const checkServiceAccount = () => {
  console.log("\n📋 [1/4] Vérification du compte de service...")
  const required = ["type", "project_id", "client_email", "private_key"]
  const missing  = required.filter(k => !SERVICE_ACCOUNT[k])

  if (missing.length > 0) {
    err(`Champs manquants dans FIREBASE_SERVICE_ACCOUNT : ${missing.join(", ")}`)
    return false
  }

  ok(`Type         : ${SERVICE_ACCOUNT.type}`)
  ok(`Projet       : ${SERVICE_ACCOUNT.project_id}`)
  ok(`Compte       : ${SERVICE_ACCOUNT.client_email}`)
  ok(`Clé privée   : ${SERVICE_ACCOUNT.private_key ? "présente" : "ABSENTE"}`)
  return true
}

const checkBucketExists = async () => {
  console.log(`\n🪣 [2/4] Vérification du bucket "${BUCKET_NAME}"...`)
  try {
    const [exists] = await storage.bucket(BUCKET_NAME).exists()
    if (!exists) {
      err(`Bucket "${BUCKET_NAME}" introuvable.`)
      inf("Créez-le dans Google Cloud Console :")
      inf("  Cloud Storage → Créer un bucket")
      inf(`  Nom : ${BUCKET_NAME}`)
      inf("  Région : europe-west1 | Classe : Standard | Accès : Uniform")
      return false
    }
    ok(`Bucket "${BUCKET_NAME}" trouvé`)
    return true
  } catch (e) {
    err(`Impossible d'accéder au bucket : ${e.message}`)
    if (e.message.includes("403") || e.message.includes("permission")) {
      inf("Le compte de service n'a pas les droits nécessaires.")
      inf("Dans IAM & Admin → IAM, ajoutez le rôle :")
      inf(`  "Storage Object Admin" sur le bucket ${BUCKET_NAME}`)
      inf(`  pour le compte : ${SERVICE_ACCOUNT.client_email}`)
    }
    return false
  }
}

const checkWriteAccess = async () => {
  console.log("\n✏️  [3/4] Test écriture dans le bucket...")
  const testFile    = storage.bucket(BUCKET_NAME).file("check-bucket-test.tmp")
  const testContent = `check-bucket test — ${new Date().toISOString()}`

  try {
    await testFile.save(testContent, { contentType: "text/plain" })
    ok("Écriture réussie")
    return true
  } catch (e) {
    err(`Écriture échouée : ${e.message}`)
    if (e.message.includes("403")) {
      inf("Rôle requis : Storage Object Admin (ou Storage Object Creator)")
      inf(`Compte de service : ${SERVICE_ACCOUNT.client_email}`)
    }
    return false
  }
}

const checkReadAndDelete = async () => {
  console.log("\n📖 [4/4] Test lecture + suppression du fichier test...")
  const testFile = storage.bucket(BUCKET_NAME).file("check-bucket-test.tmp")

  try {
    const [content] = await testFile.download()
    ok(`Lecture réussie (${content.length} bytes)`)
  } catch (e) {
    err(`Lecture échouée : ${e.message}`)
    return false
  }

  try {
    await testFile.delete()
    ok("Suppression réussie — bucket propre")
    return true
  } catch (e) {
    err(`Suppression échouée : ${e.message}`)
    inf("Nettoyez manuellement le fichier check-bucket-test.tmp dans le bucket")
    return false
  }
}

const checkBackupFolder = async () => {
  console.log("\n🗂️  Vérification du dossier backups/ existant...")
  try {
    const [files] = await storage.bucket(BUCKET_NAME).getFiles({ prefix: "backups/" })
    const jsonFiles = files.filter(f => f.name.endsWith(".json"))
    if (jsonFiles.length === 0) {
      inf("Aucun backup existant — c'est normal pour une première installation.")
      inf("Le premier backup sera créé automatiquement cette nuit à 2h00 UTC.")
      inf("Ou déclenchez-le manuellement : POST /api/admin/backup")
    } else {
      ok(`${jsonFiles.length} backup(s) trouvé(s) dans backups/`)
      const latest = jsonFiles
        .map(f => ({ name: f.name, date: new Date(f.metadata.timeCreated) }))
        .sort((a, b) => b.date - a.date)[0]
      inf(`Dernier backup : ${latest.name} (${latest.date.toLocaleString("fr-FR")})`)
    }
  } catch (e) {
    inf(`Impossible de lister backups/ : ${e.message}`)
  }
}

// ── Runner principal ─────────────────────────────────────────────
;(async () => {
  console.log("=".repeat(60))
  console.log("  check-bucket.js — Diagnostic accès Cloud Storage")
  console.log(`  Bucket cible : gs://${BUCKET_NAME}`)
  console.log(`  Projet       : ${SERVICE_ACCOUNT?.project_id || "inconnu"}`)
  console.log("=".repeat(60))

  const steps = [
    { fn: checkServiceAccount,  sync: true  },
    { fn: checkBucketExists,    sync: false },
    { fn: checkWriteAccess,     sync: false },
    { fn: checkReadAndDelete,   sync: false },
  ]

  let allOk = true

  for (const step of steps) {
    const result = step.sync ? step.fn() : await step.fn()
    if (!result) {
      allOk = false
      console.log("\n⛔ Arrêt — corrigez l'erreur ci-dessus avant de continuer.\n")
      process.exit(1)
    }
  }

  // Bonus : lister les backups existants si tout est OK
  await checkBackupFolder()

  console.log("\n" + "=".repeat(60))
  if (allOk) {
    console.log("  🎉 Tous les tests passés — le backup est prêt à fonctionner.")
    console.log("  Variables d'environnement requises dans Railway :")
    console.log(`    BACKUP_BUCKET=${BUCKET_NAME}`)
    console.log("    BACKUP_RETENTION_DAYS=30  (optionnel, défaut: 30)")
    console.log("    FIREBASE_SERVICE_ACCOUNT=<json>  (déjà configuré)")
  }
  console.log("=".repeat(60) + "\n")

  process.exit(0)
})()

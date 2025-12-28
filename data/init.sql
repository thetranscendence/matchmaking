-- ====================================================================================
-- Schéma de Base de Données - Service de Matchmaking
-- Base de données : SQLite
-- ====================================================================================

-- ------------------------------------------------------------------------------------
-- Table : penalties
-- Objectif : Stocker les sanctions temporaires appliquées aux joueurs.
-- ------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS penalties (
    -- Identifiant unique interne de la saction (Auto-incrémenté)
    id INTEGER PRIMARY KEY AUTOINCREMENT,

    -- UUID de l'utilisateur sanctionné (Référence externe vers le service Users/Auth)
    user_id TEXT NOT NULL,

    -- Motif de la saction (ex: "Refus de match répété", "Comportement toxique")
    reason TEXT,

    -- Date d'expiration de la saction (Format ISO8601 ou Timestamp)
    -- Utilisé pour vérifier l'éligibilité : SELECT * WHERE expires_at > NOW()
    expires_at DATETIME NOT NULL,

    -- Date de création de l'enregistrement (Audit)
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ------------------------------------------------------------------------------------
-- Table : matchmaking_sessions
-- Objectif : Historique et audit des sessions de jeu (Matchs).
-- ------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS matchmaking_sessions (
    -- Identifiant unique de la session (UUID généré par l'application ou le Matchmaker)
    id TEXT PRIMARY KEY,

    -- UUID du premier joueur
    player_1_id TEXT NOT NULL,

    -- UUID du second joueur
    player_2_id TEXT NOT NULL,

    -- Statut final de la session (ex: 'FINISHED', 'CANCELLED', 'ABORTED')
    status TEXT NOT NULL,

    -- Horodatage du début du match
    started_at DATETIME NOT NULL,  -- [CORRECTION] Virgule ajoutée ici

    -- Horodatage de la fin du match (Peut être NULL si en cours, bien que ce soit de l'archivage)
    ended_at DATETIME,

    -- Métadonnées supplémentaires au format JSON (ex: Scores finaux)
    -- Stocké en TEXT car SQLite ne possède pas de type JSON natif strict (mais supporte les fonctions JSON)
    metadata TEXT
);
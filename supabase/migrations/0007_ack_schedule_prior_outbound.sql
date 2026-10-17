-- Accusé par catégorie: 'always' (à toute heure) ou 'outside_hours' (seulement
-- hors des heures de bureau, quand l'équipe n'est pas là pour répondre). Ne
-- s'applique que si acknowledge_automatically = 1.
ALTER TABLE categories ADD COLUMN IF NOT EXISTS ack_schedule TEXT NOT NULL DEFAULT 'always';

-- Nombre de nos messages déjà présents dans la conversation quand le dossier
-- a été ouvert (l'équipe avait déjà échangé avec ce partenaire). Sans lui, la
-- vérification "un humain a répondu" comptait ces anciens messages comme une
-- réponse au nouveau, et le dossier passait aussitôt en "répondu".
ALTER TABLE threads ADD COLUMN IF NOT EXISTS prior_outbound_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE episode_publications
  ADD COLUMN evidence_url TEXT;

ALTER TABLE episode_publications
  ADD COLUMN evidence_source TEXT
    CHECK (
      evidence_source IS NULL
      OR evidence_source IN (
        'manual_review',
        'provider_dashboard',
        'automated_probe'
      )
    );

ALTER TABLE episode_publications
  ADD COLUMN evidence_admin_user_id TEXT
    REFERENCES admin_users(id) ON DELETE SET NULL;

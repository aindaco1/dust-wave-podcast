ALTER TABLE show_distribution_destinations
  ADD COLUMN owner_account_label TEXT
    CHECK (
      owner_account_label IS NULL
      OR (
        length(owner_account_label) BETWEEN 1 AND 120
        AND instr(owner_account_label, char(10)) = 0
        AND instr(owner_account_label, char(13)) = 0
      )
    );

ALTER TABLE show_distribution_destinations
  ADD COLUMN submission_date TEXT
    CHECK (
      submission_date IS NULL
      OR (
        length(submission_date) = 10
        AND submission_date GLOB
          '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
      )
    );

ALTER TABLE show_distribution_destinations
  ADD COLUMN submission_evidence_url TEXT;

ALTER TABLE show_distribution_destinations
  ADD COLUMN setup_notes TEXT
    CHECK (
      setup_notes IS NULL
      OR length(setup_notes) BETWEEN 1 AND 1000
    );

CREATE TABLE IF NOT EXISTS notes (
    id          SERIAL PRIMARY KEY,
    text        TEXT        NOT NULL,
    done        BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

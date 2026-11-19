-- 002_create_notes.sql
-- Notes belong to a notebook. The foreign key enforces referential integrity:
-- a note cannot point at a notebook that does not exist, and a notebook that
-- still has notes cannot be deleted. There is no ON DELETE CASCADE: on Aurora
-- DSQL the rows a cascade deletes count toward the 3,000-row limit of one
-- transaction, so deleteNotebook() in cdk-blocks/index.ts deletes the notes
-- itself, in the same transaction as the notebook.
--
-- Written as Aurora DSQL documents it: the constraint is added NOT VALID and
-- then validated by an asynchronous job, and the index is built ASYNC. The
-- block waits for each job before the next statement.
CREATE TABLE notes (
  id          TEXT PRIMARY KEY,
  notebook_id TEXT NOT NULL,
  owner       TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE notes ADD CONSTRAINT notes_notebook FOREIGN KEY (notebook_id) REFERENCES notebooks (id) NOT VALID;
ALTER TABLE ASYNC notes VALIDATE CONSTRAINT notes_notebook;

CREATE INDEX ASYNC notes_notebook_id ON notes (notebook_id);

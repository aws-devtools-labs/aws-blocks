-- An index on DSQL is always ASYNC: the statement returns a job id and the block waits for the build before the next step.
CREATE INDEX ASYNC dbx_items_name ON dbx_items (name);

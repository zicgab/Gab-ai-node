# Canary repo (do not fix)

A tiny app with problems planted on purpose. `gab-node eval` copies it to a temp
folder, asks the node's model to review it, and scores the report against
`expected.json`. Fixing these problems breaks the eval.

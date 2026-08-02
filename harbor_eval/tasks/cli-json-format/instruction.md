Extend the report CLI in `/app` with a `--format text|json` option.

The default remains `text`. JSON output must be a single object containing
`total`, `active`, and `names`, where `names` contains active user names in input
order. An unsupported format must exit with code 2 and print
`Unsupported format: <value>` to stderr. Preserve the existing text behavior and
run the tests before finishing.

Fix the configuration merge implementation in `/app`.

`mergeConfig(base, override)` must recursively merge plain objects, preserve
keys that are absent from the override, replace arrays and scalar values, and
must not mutate either input. Run the available tests and leave the project in
a passing state.

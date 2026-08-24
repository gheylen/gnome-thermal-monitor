<!-- Thanks for contributing! Please fill in the sections below. -->

## Summary

<!-- What does this PR change, and why? -->

## Type of change

- [ ] Bug fix
- [ ] New hardware backend
- [ ] New feature / enhancement
- [ ] Documentation
- [ ] Tooling / CI

## Checklist

- [ ] `make check` passes — the whole gate, which is what CI runs
- [ ] New runtime-independent logic has tests under `test/`
- [ ] A changed rule has a mutant in `tools/mutants.json`, and `make mutate` is green
- [ ] `make verify-pins` run, if a GitHub Actions pin changed (needs network)
- [ ] Docs updated if behaviour or interfaces changed

## Testing

<!-- How did you verify this? Include hardware, GNOME Shell version, and
     anything reviewers should know. New backends: which driver/hardware? -->

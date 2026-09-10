# CI and releases

CI runs repository checks, package tests, protocol tests, and docs/examples in parallel. Windows checks the installed packages. These jobs do not publish.

After merging the foundation, run **release / create-pr** on main. Choose **initial** for the first 0.0.1 release (alpha gives 0.0.1-alpha.0); later choose patch, minor, or major. Another alpha advances its counter, and stable promotes that alpha's base version. Preview is the default. The CLI, both clients, and AI SDK integration move together, including the integration's client peer range. Private workspace versions do not move.

The workflow creates a release PR and explicitly starts CI on its branch. GitHub does not trigger PR workflows from events created using GITHUB_TOKEN. If branch/PR creation succeeds but dispatch fails, run CI manually on release/next. Finish or remove that branch before preparing another release. Squash-merge the release PR with its generated **chore: release v…** title. Release intent is recorded in release-state.json; ordinary foundation merges cannot publish.

**release / publish** runs the existing CI, builds and tests the exact artifacts, then publishes through the protected **release** environment. Dry runs never publish. For a retry, supply the original full main-branch release SHA; missing versions are published and registry convergence precedes the GitHub release. No registry tokens belong in this repository.

Before the first publication, a maintainer must own the npm scope, bootstrap the three legitimate npm package records, and configure their trusted publishers, plus PyPI's pending publisher. Use repository **ranst91/remote-skills**, workflow **publish-release.yml**, environment **release**. Configure main-only deployment and the intended human approval policy. Registry setup is external; adding these workflows does not complete it. npm OIDC supports private repositories, but npm provenance requires a public repository. After making the repository public, verify its publishing provenance and environment protection before the official release.

The five local artifacts are three npm tarballs plus the Python wheel and source distribution. Before offline packaging checks, dependency setup seeds package contents and registry metadata using the integration's pinned direct runtime dependencies. Consumer checks then run offline; this is not an empty-cache test. No live model calls are needed for packaging tests.

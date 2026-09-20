# Group download measurement and fork updates

Approved in the task conversation on 2026-09-20. The fork owner requested the existing group delay button to measure latency and download speed, with no upload test. This owner-approved specification governs this fork's local work; no upstream contribution or issue creation is requested.

The same button starts a latency batch followed by sequential download measurements and becomes a stop button while active. Node cards retain latency and show download speed or an explicit pending, failed, or cancelled state. Automatic background delay checks remain latency-only. Switching profiles cancels the batch and invalidates its results.

Follow-up requested on 2026-09-21: clicking an individual node's latency/check control measures latency and download for that node only. It preserves the selected production proxy and other nodes' results. Node clicks during an active test leave that test running. Concurrent batch downloading was explicitly deferred. The owner subsequently authorized installation and publication of this fork as v2.5.5.

Use the application's existing Mihomo binary in a temporary, isolated process. Bind its authenticated controller and proxy port to loopback only. Never change the active core's selected nodes, mode, listeners, TUN, or system proxy. Preserve node protocol fields, provider identity, DNS and dialer dependencies from the effective runtime configuration. Stop and clean up on cancellation, errors and completion. Do not silently route an unresolved node through another proxy.

Default to https://speed.cloudflare.com/__down?bytes=50000000. Provide a persisted custom HTTPS/HTTP download URL under miscellaneous settings. Use the same target for a batch, do not automatically substitute endpoints, validate HTTP success and measure actual streamed bytes with monotonic time. Limit each node's payload to 50 MB and download sampling to 5 seconds; connection setup has a separate bounded timeout. Results describe throughput to this target, not a universal maximum. A 53-node batch may use approximately 2.65 GB plus transport overhead.

Application update checks, stable/alpha endpoints, release links, update manifests and release packaging must target Cansiny0320/clash-verge-rev. Preserve signature verification using a new fork-owned signing key; keep the private key outside Git. An unpublished channel must report unavailable, not silently use upstream. Mihomo core releases remain MetaCubeX releases because the fork does not publish its own core.

Validate queue cancellation, node identity, byte/time bounds, failed downloads, configuration isolation, update source consistency and signature verification. Validate the frontend and Rust build where toolchains permit, and distinguish simulated tests from real proxy measurements. No commit, push, remote secrets, release or installation is authorized by this implementation approval.

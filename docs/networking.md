## Networking

Ports exposed by processes inside agt are automatically accessible from the host. No extra configuration is needed.

### Container mode

Containers run on Apple's vmnet network and get their own IP address. With mDNS, they are reachable at:

```
<container-name>.local:<port>
```

For example, a container started with `agt start my-feature` running a dev server on port 3000 is accessible at:

```
agt-my-feature.local:3000
```

Dev servers must bind to `0.0.0.0` (not `127.0.0.1`) to be reachable from the host. Most frameworks do this when you pass `--host`:

```sh
vite --host
next dev -H 0.0.0.0
```

### Sandbox mode

Sandbox-exec runs processes directly on the host, so any listening port is available at `localhost:<port>` with no additional setup.

#!/bin/sh

emit() { printf '%s\t%s\n' "$1" "$2"; }
pass() { emit "$1" pass; }
fail() { emit "$1" fail; }

allowed() {
  assertion=$1
  shift
  if "$@" >/dev/null 2>&1; then
    pass "$assertion"
  else
    fail "$assertion"
  fi
}

denied() {
  assertion=$1
  shift
  if "$@" >/dev/null 2>&1; then
    fail "$assertion"
  else
    pass "$assertion"
  fi
}

absent() {
  if [ ! -e "$2" ]; then
    pass "$1"
  else
    fail "$1"
  fi
}

profile=$1
gateway=$2
shift 2

if [ "$(id -u)" = 10001 ]; then
  pass unprivileged-uid
else
  fail unprivileged-uid
fi

groups=" $(id -G) "
case "$groups" in
  *" 0 "*) fail unprivileged-groups ;;
  *" 10001 "*) pass unprivileged-groups ;;
  *) fail unprivileged-groups ;;
esac

if [ "$(cat /workspace/base/canary.txt 2>/dev/null)" = base-marker ] \
  && [ "$(cat /workspace/input/canary.txt 2>/dev/null)" = input-marker ] \
  && [ "$(cat /workspace/project/canary.txt 2>/dev/null)" = project-marker ]; then
  pass source-readable
else
  fail source-readable
fi

denied base-read-only touch /workspace/base/.orchestrator-canary
denied input-read-only touch /workspace/input/.orchestrator-canary
if [ "$profile" = read ]; then
  denied project-access touch /workspace/project/.orchestrator-canary
else
  allowed project-access touch /workspace/project/.orchestrator-canary
fi
allowed output-writable touch /sandbox/output/.orchestrator-canary

denied openshell-token-inaccessible cat /etc/openshell/auth/sandbox.jwt
denied openshell-key-inaccessible cat /etc/openshell/tls/client/tls.key
absent docker-socket-absent /var/run/docker.sock

absent host-sentinel-inaccessible "$1"
absent host-home-inaccessible "$2"
absent host-state-inaccessible "$3"
absent host-checkout-inaccessible "$4"
absent host-git-inaccessible "$5"
absent sibling-repositories-inaccessible "$6"
absent host-ssh-agent-inaccessible "$7"

credential_status=pass
for name in \
  ANTHROPIC_API_KEY \
  AWS_ACCESS_KEY_ID \
  AWS_PROFILE \
  AWS_SECRET_ACCESS_KEY \
  AWS_SESSION_TOKEN \
  DATABASE_URL \
  DOCKER_HOST \
  GOOGLE_APPLICATION_CREDENTIALS \
  OPENAI_API_KEY \
  SSH_AUTH_SOCK; do
  if printenv "$name" >/dev/null 2>&1; then
    credential_status=fail
  fi
done
emit host-credentials-absent "$credential_status"

denied external-network-denied \
  curl --silent --show-error --max-time 5 https://example.com
denied host-gateway-denied \
  curl --insecure --silent --show-error --max-time 5 "$gateway"
denied privileged-mount-denied unshare --mount /usr/bin/true

exit 0

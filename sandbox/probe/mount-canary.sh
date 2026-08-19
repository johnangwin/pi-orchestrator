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

identity() {
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
}

isolation() {
  gateway=$1
  shift

  denied openshell-token-inaccessible cat /etc/openshell/auth/sandbox.jwt
  denied openshell-key-inaccessible cat /etc/openshell/tls/client/tls.key
  absent docker-socket-absent /var/run/docker.sock

  for assertion in \
    host-sentinel-inaccessible \
    host-home-inaccessible \
    host-state-inaccessible \
    host-checkout-inaccessible \
    sibling-repositories-inaccessible \
    volume-source-inaccessible \
    host-ssh-agent-inaccessible; do
    absent "$assertion" "$1"
    shift
  done

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
}

writer() {
  token=$1
  gateway=$2
  shift 2

  identity

  if [ "$(cat /workspace/project/visible.txt 2>/dev/null)" = visible ]; then
    pass workspace-readable
  else
    fail workspace-readable
  fi

  denied root-read-only touch /workspace/project/.root-write
  denied sibling-read-only touch /workspace/project/sibling/.sibling-write
  denied protected-read-only \
    touch /workspace/project/task/protected/.protected-write

  create="/workspace/project/task/create-$token"
  if printf 'created\n' >"$create" 2>/dev/null \
    && [ "$(cat "$create" 2>/dev/null)" = created ]; then
    pass write-create
  else
    fail write-create
  fi
  rm -f "$create"

  replace="/workspace/project/task/replace-$token"
  if printf 'old\n' >"$replace" 2>/dev/null \
    && printf 'new\n' >"$replace" 2>/dev/null \
    && [ "$(cat "$replace" 2>/dev/null)" = new ]; then
    pass write-replace
  else
    fail write-replace
  fi
  rm -f "$replace"

  rename_source="/workspace/project/task/rename-source-$token"
  rename_target="/workspace/project/task/rename-target-$token"
  if printf 'rename\n' >"$rename_source" 2>/dev/null \
    && mv "$rename_source" "$rename_target" 2>/dev/null \
    && [ "$(cat "$rename_target" 2>/dev/null)" = rename ]; then
    pass write-rename
  else
    fail write-rename
  fi
  rm -f "$rename_source" "$rename_target"

  delete="/workspace/project/task/delete-$token"
  if printf 'delete\n' >"$delete" 2>/dev/null \
    && rm "$delete" 2>/dev/null \
    && [ ! -e "$delete" ]; then
    pass write-delete
  else
    fail write-delete
  fi

  if [ ! -e /workspace/project/.git ]; then
    pass git-absent
  else
    fail git-absent
  fi
  if ! mkdir /workspace/project/.git >/dev/null 2>&1 \
    && ! printf 'replacement\n' >/workspace/project/.git 2>/dev/null; then
    pass git-create-denied
  else
    fail git-create-denied
  fi

  if [ "$(cat /workspace/project/restricted.txt 2>/dev/null)" = \
    "pi-orchestrator opaque mount" ]; then
    pass restricted-file-masked
  else
    fail restricted-file-masked
  fi
  if restricted_listing=$(ls -A /workspace/project/restricted-dir 2>/dev/null) \
    && [ -z "$restricted_listing" ]; then
    pass restricted-directory-masked
  else
    fail restricted-directory-masked
  fi
  if [ ! -e /run-volume/control ] && [ ! -e /run-volume/git ]; then
    pass volume-control-inaccessible
  else
    fail volume-control-inaccessible
  fi

  if printf '%s\n' "$token" >/workspace/project/task/shared.txt 2>/dev/null; then
    pass shared-write-created
  else
    fail shared-write-created
  fi

  isolation "$gateway" "$@"
}

reader() {
  token=$1
  if [ "$(cat /workspace/project/task/shared.txt 2>/dev/null)" = "$token" ]; then
    pass shared-write-visible
  else
    fail shared-write-visible
  fi
  denied reader-root-read-only touch /workspace/project/.reader-root-write
  denied reader-task-read-only touch /workspace/project/task/.reader-task-write
}

mode=$1
shift
case "$mode" in
  writer) writer "$@" ;;
  reader) reader "$@" ;;
  *) exit 64 ;;
esac

exit 0

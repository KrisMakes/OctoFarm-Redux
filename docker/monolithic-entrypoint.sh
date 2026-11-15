#!/bin/sh
mkdir -p /data/db /data/logs /app/logs

# Session signing key. The application generates one when this is unset, but it
# cannot keep it: the only place it knows to write is a .env file, and that write
# is deliberately skipped inside a container. So an unset key means a fresh key
# on every start, and a fresh key invalidates every existing login session - the
# whole farm is logged out each time the container is recreated. Hold one in the
# database directory instead, which outlives the container.
#
# It goes under /data/db specifically, not /data: only the mapped paths survive
# a `docker rm`, and /data/db is the one mapping the application cannot run
# without, so the key cannot be lost by forgetting a volume. mongod ignores the
# file - verified against mongo 8 by restarting it with the file in place.
#
# An explicit SUPER_SECRET_KEY always wins; nothing here touches it.
SECRET_FILE=/data/db/.super_secret_key
if [ -z "$SUPER_SECRET_KEY" ]; then
    if [ ! -s "$SECRET_FILE" ]; then
        # 48 bytes of urandom as hex. umask, not chmod, so the key is never
        # readable between creation and the permission change.
        ( umask 077; od -An -tx1 -N48 /dev/urandom | tr -d ' \n' > "$SECRET_FILE" )
        echo "entrypoint: no SUPER_SECRET_KEY set; generated one in $SECRET_FILE"
        echo "entrypoint: sessions will now survive a restart. Pass the variable"
        echo "entrypoint: explicitly if you would rather manage the key yourself."
    fi
    SUPER_SECRET_KEY=$(cat "$SECRET_FILE")
    export SUPER_SECRET_KEY
fi

# Fork mongod rather than backgrounding it, so it has a pid we can signal and
# can be asked to flush and exit cleanly on the way down.
mongod --dbpath /data/db --fork --logpath /data/logs/mongod.log

# Docker sends SIGTERM to pid 1. Without this trap the shell ignores it, the
# container is SIGKILLed once the stop timeout expires, and mongod has to replay
# its journal on the next start.
shutdown_cleanly() {
    pm2 stop OctoFarm >/dev/null 2>&1
    mongod --dbpath /data/db --shutdown >/dev/null 2>&1
    exit 0
}
trap shutdown_cleanly TERM INT

cd server && pm2 start app.js --name OctoFarm --no-daemon -o '../logs/pm2.log' -e '../logs/pm2.error.log' --time  --restart-delay=1000 --exp-backoff-restart-delay=1500 &

# wait returns as soon as a trapped signal arrives, which is what lets the
# handler above run before the container is killed.
wait $!

#!/bin/sh
set -eu

client_cidr=${SITEOFFER_EGRESS_CLIENT_CIDR:-172.30.240.0/24}
invalid() { echo 'A dedicated private client CIDR with prefix /16 through /30 is required.' >&2; exit 2; }
case "$client_cidr" in ''|*[!0-9./]*) invalid ;; esac
awk -v cidr="$client_cidr" 'BEGIN {
  if (split(cidr, a, "/") != 2 || split(a[1], b, "[.]") != 4) exit 1;
  if (a[2] !~ /^[1-9][0-9]*$/ || a[2] < 16 || a[2] > 30) exit 1;
  address = 0;
  for (i = 1; i <= 4; i++) {
    if (b[i] !~ /^[0-9]+$/ || b[i] > 255 || (length(b[i]) > 1 && substr(b[i], 1, 1) == "0")) exit 1;
    address = address * 256 + b[i];
  }
  if (!(b[1] == 10 || (b[1] == 172 && b[2] >= 16 && b[2] <= 31) || (b[1] == 192 && b[2] == 168))) exit 1;
  if (address % (2 ^ (32 - a[2])) != 0) exit 1;
}' || invalid

runtime_config=$(mktemp /tmp/siteoffer-squid.XXXXXX)
sed "s#__SITEOFFER_EGRESS_CLIENT_CIDR__#$client_cidr#g" /etc/squid/squid.conf > "$runtime_config"
exec squid -N -d 1 -f "$runtime_config"

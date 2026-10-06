#!/usr/bin/env bash
# Print the current time of day: clock time plus the matching period.
set -euo pipefail

now=$(date '+%H:%M:%S')
hour=$(date '+%H')

if (( hour < 12 )); then
  period="morning"
elif (( hour < 17 )); then
  period="afternoon"
elif (( hour < 21 )); then
  period="evening"
else
  period="night"
fi

echo "Good ${period}! The current time is ${now} ($(date '+%Z'))."

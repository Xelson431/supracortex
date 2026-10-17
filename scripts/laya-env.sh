# Load only Laya's bearer key for SupraCode launchers without executing the
# system env file. An already-exported key always takes precedence.
if [[ -z "${LAYA_API_KEY:-}" && -r /etc/laya/laya.env ]]; then
  while IFS= read -r _laya_env_line || [[ -n "$_laya_env_line" ]]; do
    if [[ "$_laya_env_line" =~ ^[[:space:]]*(export[[:space:]]+)?LAYA_API_KEY[[:space:]]*=(.*)$ ]]; then
      _laya_env_value="${BASH_REMATCH[2]}"
      _laya_env_value="${_laya_env_value%$'\r'}"
      _laya_env_value="${_laya_env_value#"${_laya_env_value%%[![:space:]]*}"}"
      _laya_env_value="${_laya_env_value%"${_laya_env_value##*[![:space:]]}"}"
      if [[ "$_laya_env_value" == \"*\" && "$_laya_env_value" == *\" ]]; then
        _laya_env_value="${_laya_env_value:1:${#_laya_env_value}-2}"
      elif [[ "$_laya_env_value" == \'*\' && "$_laya_env_value" == *\' ]]; then
        _laya_env_value="${_laya_env_value:1:${#_laya_env_value}-2}"
      else
        _laya_env_value="${_laya_env_value%%[[:space:]]\#*}"
      fi
      if [[ -n "$_laya_env_value" ]]; then
        export LAYA_API_KEY="$_laya_env_value"
      fi
      break
    fi
  done < /etc/laya/laya.env
  unset _laya_env_line _laya_env_value
fi

"""ALLEMM SIP: softphone SIP de escritorio (PJSIP + interfaz web local)."""

import os
import sys

# En desarrollo, el módulo pjsua2 compilado vive en third_party/pjsua2.
_THIRD = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "third_party", "pjsua2")
if os.path.isdir(_THIRD) and _THIRD not in sys.path:
    sys.path.append(_THIRD)

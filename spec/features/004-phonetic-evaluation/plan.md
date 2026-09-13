# 004 · Evaluación fonética por audio — Plan

No iniciado. Ver spec.md.

Pre-nota de arquitectura: sidecar Python local (parselmouth/librosa) expone API `/pronounce`; el core Node llama por HTTP y degrada a transcripción si no responde. Es el modulo donde Python es la tecnología adecuada (ver tech-stack.md).
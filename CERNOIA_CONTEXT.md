# CernoIA — contexto operativo

Actualizado: 2026-09-27 UTC.

- Repositorio de producción: `/home/cernoiaapp/htdocs/cernoia.secretbloom.tech`.
- Remoto Git: `origin` mediante SSH hacia `Victor-Camargo-A/Cernoia`; rama principal `main`.
- El acceso usa una clave SSH dedicada del usuario de servicio y verificación estricta de la clave de host de GitHub. No documentar ni versionar claves privadas.
- `.gitignore` excluye entornos, runtime, dependencias, builds y copias históricas de despliegue. Antes de nuevos commits: `git status --short` y revisar sólo el diff afectado.
- No ejecutar despliegues desde Git sin una tarea explícita y validación localizada.

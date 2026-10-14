# Cosa cambia nella config da una release precedente alla 12.1

Elenco dei cambi che toccano una configurazione esportata da PAN-OS 10.x o 11.x e caricata su un firewall 12.1, con la fonte di ciascuno e come lo gestisce lo strumento.

PAN-OS applica le proprie migrazioni anche a una config **caricata da file**, in base alla versione dichiarata nell'XML: caricando su un PA-550 12.1 un backup 10.2.16, gli IKE gateway senza versione hanno ricevuto `ikev1` esplicito. Per questo lo strumento **non modifica** gli attributi `version` e `detail-version` della sorgente. Le regole di versione dello strumento producono lo stesso risultato in anticipo, così il report mostra cosa cambierà, ma non sostituiscono le migrazioni di PAN-OS.

## Cambi che modificano la config

| Release | Cambio | Effetto su una config vecchia | Cosa fa lo strumento | Fonte |
|---|---|---|---|---|
| 10.2 → 12.1.2 | Advanced Routing Engine; sui PA-500 è l'unico motore | `network/virtual-router` non è accettato, il commit fallisce con `Disabling advanced routing is not allowed on this platform` | Converte i virtual router in logical router, imposta `advance-routing` a `yes` (regola «Advanced Routing») | [Enable Advanced Routing][are], [LIVEcommunity][live] |
| 10.2+ | Nomi delle static route: nel motore legacy ammettono spazi, nell'Advanced Routing no | Una route con uno spazio nel nome non è valida nel logical router | Sostituisce gli spazi con `_`, come nella migrazione reale (`Arub VPNC` → `Arub_VPNC`). La guida vieta anche il punto, ma un PA-550 12.1.7 in produzione ha route con punti nel nome: non vengono toccati | [Create a Static Route (ARE)][sr-are], [Static Routes (legacy)][sr-vr], migrazione PA-460 → PA-550 |
| 10.2+ | Path monitoring HA con Advanced Routing | `path-group/virtual-router` va sostituito da `path-group/logical-router` | Sposta le entry, struttura invariata (`destination-ip-group`) | [HA Link and Path Monitoring][pathmon], export PA-550 12.1.7 |
| 11.1 | SSL/TLS service profile: aggiunto TLS 1.3 | Con versione massima «Max» l'upgrade ufficiale imposta TLSv1.2; una config caricata da file con «Max» abiliterebbe TLS 1.3 | Se la sorgente è < 11.1, `max-version` «Max» o assente diventa `tls1-2` | [Upgrade considerations][upg] |
| 11.1 | Cifrario ChaCha20-Poly1305 nei profili SSL/TLS | Il vecchio `enc-algo-chacha20-poly1305` fa fallire il commit («unexpected here»); nelle config 12.x l'elemento è `enc-algo-aes-chacha20-poly1305` | Rinomina e segnala da verificare. Nei decryption profile il nome non cambia e non viene toccato | [Upgrade considerations][upg], export PA-550 12.1.3 e 12.1.7 |
| 11.2 | Versione IKE predefinita: da IKEv1 a IKEv2 | Un IKE gateway senza `protocol/version` passa a IKEv2 e la VPN con un peer IKEv1 non si stabilisce | Se la sorgente è < 11.2, imposta `protocol/version` = `ikev1` sui gateway che non la indicano | [Changes to default behavior 11.2][cdb112], [12.1][cdb121] |

## Cambi di comportamento da verificare

| Release | Cambio | Cosa fa lo strumento | Fonte |
|---|---|---|---|
| 11.1.1 | Authentication sequence: «Exit the sequence on failed authentication» non dipende più da «Use domain to determine authentication profile» | Segnala le sequenze se la sorgente è < 11.1.1 | [Upgrade considerations][upg] |
| 11.2.0 | Con Advanced Routing, multicast non supportato e BGP dampening non applicato (solo 11.2.0) | Multicast e dampening finiscono nel report come attività manuali | [Upgrade considerations][upg] |
| 12.1 | TLS 1.3 in SSL Forward Proxy solo con X25519, X448, secp256r1, secp384r1, secp521r1 | Segnala i decryption profile con forward proxy e TLS 1.3 se la sorgente è < 12.1 | [Changes to default behavior 12.1][cdb121] |
| 12.1 | Il caricamento di una config salvata chiede conferma; un caricamento parziale può essere interrotto | Nota nella scheda «Caricamento» | [Changes to default behavior 12.1][cdb121] |
| 12.1 | Password del maintenance mode da cambiare, il seriale non vale più | Nessuna: non è nella config | [Changes to default behavior 12.1][cdb121] |
| 12.1 | Per i VPN cluster restano solo IKEv2; spariscono «IKEv1 only» e «IKEv2 preferred» | Nessuna: i PA-500 non hanno VPN cluster. Sui gateway normali `ikev2-preferred` resta valido (presente in un export 12.1.7) | [Changes to default behavior 12.1][cdb121] |

## Come scrive la config un PA-550 con Advanced Routing (12.1.7)

Dall'export di un PA-550 in produzione, riprodotto in forma sintetica in `test/pa550-are-funzionante.xml`:

- `deviceconfig/setting/advance-routing` presente e a `yes` (un altro export 12.1.3 non contiene l'elemento);
- nessun `network/virtual-router`;
- logical router con VRF `default`, `admin-dists` scritte esplicitamente con i default ARE (OSPF 110, BGP interno 200, esterno 20, statiche 10);
- blocchi `bgp`, `ospf`, `ospfv3`, `rip`, `multicast` presenti anche se disattivati;
- static route con `bfd/profile` a `None`, alcune solo su interfaccia (senza `nexthop`);
- path group HA `logical-router` con `destination-ip-group`;
- `vsys/entry/import/network` con le sole interfacce, senza router (vedi issue #15).

Tutti gli elementi del logical router reale esistono negli schemi di [pan-os-codegen][codegen].

## Migrazione reale 10.2.16 → 12.1 (PA-460 → PA-550)

Confronto tra il backup di un PA-460 con PAN-OS 10.2.16 e gli export dello stesso cliente su PA-550, prima con 12.1.3 e poi con 12.1.7, ignorando i cambi di infrastruttura (porte, aggregate, HA, indirizzi).

**Fatto da PAN-OS al caricamento** (presente già nell'export 12.1.3):
- `protocol/version` = `ikev1` sui 4 IKE gateway che non indicavano la versione; il quinto aveva già `ikev2-preferred` ed è rimasto tale;
- valori di default scritti per campi nuovi: `use-default-browser` nel portale GlobalProtect, `bypass-web-proxy-authentication` nelle regole di authentication.

**Scritto dalla 12.1.7** (nuovi campi con i default, nessuna conversione necessaria): elementi IKEv2 post-quantum e `ikev2-fragment` sui gateway, `ssl-protocol-settings` esplicito nei decryption profile, `encrypted-dns` nel DNS proxy, `saas-tenant-list` e `saas-user-list` nelle regole modificate.

**Routing, fatto a mano sul PA-550:** il virtual router `vr1` è diventato il logical router `vr1`.
- Le 30 route rimaste coincidono con quelle del 460 per destinazione, next hop e metrica; cambiano solo i nomi delle interfacce.
- `route-table/unicast` sparisce; le route solo su interfaccia restano senza `nexthop`.
- Ogni route riceve `bfd/profile` = `None`, il default.
- La route con lo spazio nel nome è stata rinominata.
- Le admin distance sono ai default ARE, quindi OSPF interno a 110 invece del 30 legacy; OSPF era spento.

Lo strumento, applicato al backup 10.2.16, produce lo stesso logical router, a parte i nomi delle interfacce, che dipendono dalla mappatura delle porte.

**Persi nel passaggio intermedio 12.1.3** (caricamento parziale con interfacce rinominate, poi ricostruito a mano):
- le 31 static route;
- le interfacce di 27 zone;
- la source NAT di 14 regole;
- i 10 server e relay DHCP;
- 3 voci del DNS proxy.

È il tipo di perdita che la mappatura delle porte dello strumento evita, rinominando le interfacce in tutta la config invece di scartarne i riferimenti.

## Novità che una config vecchia non ha

Confrontando l'export 12.1.7 con gli schemi di pan-os-codegen (allineati alla 11.0) risultano nuovi, e quindi assenti nelle config precedenti, senza bisogno di conversione: IKEv2 post-quantum (`pq-kem`, `pq-ppk`, `pq-qkd`) e `ikev2-fragment`; `encrypted-dns` nel DNS proxy; `gp-gw-dhcp` nel gateway GlobalProtect; `use-default-browser` nel portale; `tls1-3` e `enc-algo-aes-chacha20-poly1305` nei profili SSL/TLS; `ipv6-enable` nelle impostazioni SD-WAN delle aggregate.

## Limiti

Il confronto con gli schemi trova gli elementi **aggiunti** dopo la 11.0, non quelli **rimossi o rinominati**: per quelli servono le note di rilascio, un export legacy reale (issue #8) e gli errori di validate sul PA-500, che il passo 4 della pagina trasforma in regole.

[are]: https://docs.paloaltonetworks.com/ngfw/networking/advanced-routing/enable-advanced-routing
[live]: https://live.paloaltonetworks.com/t5/next-generation-firewall/migration-problem-from-pa220-to-pa540-virtual-router/td-p/1247661
[pathmon]: https://docs.paloaltonetworks.com/pan-os/11-2/pan-os-web-interface-help/device/device-high-availability/ha-link-and-path-monitoring
[upg]: https://docs.paloaltonetworks.com/pan-os/11-1/pan-os-upgrade/upgrade-pan-os/upgradedowngrade-considerations
[cdb112]: https://docs.paloaltonetworks.com/pan-os/11-2/pan-os-release-notes/changes-to-default-behavior/changes-to-default-behavior-in-pan-os-11-2
[cdb121]: https://docs.paloaltonetworks.com/ngfw/release-notes/12-1/changes-to-default-behavior/changes-to-default-behavior-in-pan-os-12-1
[codegen]: https://github.com/PaloAltoNetworks/pan-os-codegen
[sr-are]: https://docs.paloaltonetworks.com/pan-os/10-2/pan-os-networking-admin/advanced-routing/create-a-static-route
[sr-vr]: https://docs.paloaltonetworks.com/pan-os/11-0/pan-os-web-interface-help/network/network-virtual-routers/static-routes

# MeshLog Web Fork
Web side for [MeshCore logger firmware](https://github.com/Anrijs/MeshCore/tree/logger)

## Requirements
- Git
- Docker
- Docker compose

## Installation
1. Clone repo git clone https://github.com/Andrew-a-g/Meshlog
2. Edit the usernames and passwords in docker-compose.yml
3. Flash logger node [MeshCore logger firmware](https://github.com/Anrijs/MeshCore/tree/logger) (Xiao S3 and T3S3 are currently supported)
4. Conenct to logger node via serial and set configuration:
 - `log url https://<your_site>/meshlog/log.php` Where data is sent (should point to `log.php` file)
 - `log report 1800` Self-report interval, can be 0 to disable
 - `log auth SomeSecret` Secret used for web authorization
 - `wifi ssid YourWifiSSID`
 - `wifi password YourWifiPassword`
 - `set name  Node Name`
 - `set lat xx.xxxxx`
 - `set lon xx.xxxxx`
 - `reboot` Apply changes
5. Add reporter to database:
   Manually via phpmyadmin or command line...
```sql
INSERT INTO `reporters` (`name`, `public_key`, `lat`, `lon`, `auth`, `authorized`, `color`)
VALUES ('ANR-Log', 'LOGGER_NODE_PUBLIC_KEY', '56.0', '27.0', 'SomeSecret', '1', 'red')
```
or navigate to setup-logger.php for a basic webui

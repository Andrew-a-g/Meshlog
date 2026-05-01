<?php

require_once 'utils.php';
require_once 'meshlog.entity.class.php';
require_once 'meshlog.advertisement.class.php';
require_once 'meshlog.contact.class.php';
require_once 'meshlog.direct_message.class.php';
require_once 'meshlog.channel_message.class.php';
require_once 'meshlog.channel.class.php';
require_once 'meshlog.reporter.class.php';
require_once 'meshlog.setting.class.php';
require_once 'meshlog.telemetry.class.php';
require_once 'meshlog.user.class.php';
require_once 'meshlog.report.class.php';
require_once 'meshlog.raw_packet.class.php';
require_once 'meshlog.decoder.php';

define("MAX_COUNT", 2500);
define("DEFAULT_COUNT", 500);
define("DEFAULT_CONTACTS_COUNT", 2000);
define("MAX_GETALL_REPORTS_COUNT", 5000);

class MeshLog {
    private $error = '';
    private $version = 10;
    private $settings = array(
        MeshlogSetting::KEY_DB_VERSION => 0,
        MeshlogSetting::KEY_MAX_CONTACT_AGE => 1814400,
        MeshlogSetting::KEY_MAX_GROUPING_AGE => 21600,
        MeshlogSetting::KEY_INFLUXDB_URL => "",
        MeshlogSetting::KEY_INFLUXDB_DB => "Meshlog"
    );

    function __construct($config) {
        $host = $config['host'] ?? die("Invalid db config");
        $name = $config['database'] ?? die("Invalid db config");
        $user = $config['user'] ?? die("Invalid db config");
        $pass = $config['password'] ?? die("Invalid db config");
        $this->pdo = new PDO("mysql:host=$host;dbname=$name;charset=utf8mb4", $user, $pass);
        $this->pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
        $this->loadSettings();

        $this->error = $this->checkUpdates();
    }

    function __destruct() {
        $this->pdo = null;
    }

    function getError() {
        return $this->error;
    }

    function loadSettings() {
        $table = MeshLogSetting::getTable();
        $stmt = $this->pdo->prepare("SELECT COUNT(*) 
                FROM information_schema.tables 
                WHERE table_schema = DATABASE() 
                AND table_name = :table");
            $stmt->execute(['table' => $table]);

        if ($stmt->fetchColumn() > 0) {
            $settings = MeshLogSetting::getAll($this, array());
            foreach ($settings['objects'] as $s) {
                $k = $s['name'];
                $v = $s['value'];
                if ($k) {
                    $this->settings[$k] = $v;
                }
            }

            $users = MeshLogUser::countAll($this);
            if ($users > 0) return;
        }
        $this->error = 'Setup not complete. Go to <a href="setup.php">setup</a>';
    }

    function getDbVersion() {
        return $this->getConfig(MeshlogSetting::KEY_DB_VERSION, 0);
    }

    function updateAvailable() {
        return $this->version != $this->getDbVersion();
    }

    function checkUpdates() {
        if ($this->version != $this->getConfig(MeshlogSetting::KEY_DB_VERSION, 0)) {
            return "Database upgrade required! <a href=\"setup.php\">Login</a>";
        };
        return 0;
    }

    function saveSettings() {
        MeshLogSetting::saveSettings($this, $this->settings);
    }

    function getConfig($key, $default=null) {
        if (!isset($this->settings[$key])) return $default;
        return $this->settings[$key];
    }

    function setConfig($key, $value) {
        // TODO write DB
    }

    function authorize($data) {
        if (!isset($_SERVER['HTTP_AUTHORIZATION'])) return false;
        if (!isset($data['reporter'])) return false;

        $count = 1;
        $pubkey = $data['reporter'];
        $token = $_SERVER['HTTP_AUTHORIZATION'];
        $token = str_replace("Bearer ", "", $token, $count);

        $query = $this->pdo->prepare('SELECT * FROM reporters WHERE public_key = :pubkey AND auth = :auth AND authorized = 1');
        $query->bindParam(':pubkey',$pubkey, PDO::PARAM_STR);
        $query->bindParam(':auth',  $token,  PDO::PARAM_STR);
        $query->execute();

        $result = $query->fetch(PDO::FETCH_ASSOC);

        if (!$result) return false;

        return MeshLogReporter::fromDb($result, $this);
    }

    function insert($data) {
        $reporter = $this->authorize($data);
        if (!$reporter) return false;

        if (!isset($data['type'])) return $this->repError('invalid type');

        $type = $data['type'];
        $version =$data['version'];

        if ($version == 2) {
            if ($type == 'RAW') {
                $this->pdo->beginTransaction();
                $rep = $this->insertRawPacket($data, $reporter, true);

                if (is_array($rep) && array_key_exists("error", $rep)) {
                    $rep["error"];
                    $this->pdo->rollBack();
                } else {
                    $this->pdo->commit();
                }
            }
        } else if ($version == 1) {
            try {
                $this->pdo->beginTransaction();
                $rep = array();
                switch ($type) {
                    case 'ADV':
                        $rep = $this->insertAdvertisement($data, $reporter);
                        break;
                    case 'MSG':
                        $rep = $this->insertDirectMessage($data, $reporter);
                        break;
                    case 'PUB':
                        $rep = $this->insertGroupMessage($data, $reporter);
                        break;
                    case 'SYS':
                        $rep = $this->insertSelfReport($data, $reporter);
                        break;
                    case 'TEL':
                        $rep = $this->insertTelemetry($data, $reporter);
                        break;
                    case 'RAW':
                        $rep = $this->insertRawPacket($data, $reporter);
                        break;
                    default:
                        $rep = $this->repError("Unknowwn type: $type");
                        break;
                }

                if (is_array($rep) && array_key_exists("error", $rep)) {
                    $rep["error"];
                    $this->pdo->rollBack();
                } else {
                    $this->pdo->commit();
                }
            } catch (Throwable $e) {
                $this->pdo->rollBack();
                error_log($e);
                throw $e;
            }
        } else {
            error_log("Bad log version: $version");
        }
    }

    private function insertAdvertisement($data, $reporter) {
        if (!$reporter) return $this->repError('no reporter');

        $pubkey = $data['contact']['pubkey'] ?? null;
        if (!$pubkey) return $this->repError('no key');

        $encname = $data['contact']['name'];
        $data['contact']['name'] = $encname;

        $contact = MeshLogContact::findBy("public_key", $pubkey, $this, array(), false, true);

        if ($contact) {
            $contact->name = $data['contact']['name'];
            if (array_key_exists('hash_size', $data)) {
                $hs = intval($data['hash_size']);
                if ($hs > 1) {
                    $contact->multibyte = 1;
                }
                if ($hs > intval($contact->hash_size)) {
                    $contact->hash_size = $data['hash_size'];
                }
            }
        } else {
            $contact = MeshLogContact::fromJson($data, $this);
            $contact->name = $data['contact']['name'];
        }
        if (!$contact->save($this)) return $this->repError('failed to save contact');

        // Find adv by id, not older than X
        $adv = MeshLogAdvertisement::fromJson($data, $this);
        $adv->contact_ref = $contact;

        // Time grouping
        // Can't use sent_at. Device after reboot might send advert
        // with bad date, making hash duplicate with older messages
        $minage = date("Y-m-d H:i:s", time() -  $this->getConfig(MeshlogSetting::KEY_MAX_GROUPING_AGE));
        $existing = MeshLogAdvertisement::findBy(
            "hash",
            $adv->hash,
            $this,
            array('created_at' => array('operator' => '>', 'value' => $minage)),
            false,
            true
        );

        if ($existing) {
            $adv = $existing;
            $saved = true;
        } else {
            $saved = $adv->save($this);
            $contact->updateHeardAt($this);
        }

        if ($saved) {
            // add report
            $rep = MeshLogAdvertisementReport::fromJson($data, $this);
            $rep->object_id = $adv->getId();
            $rep->reporter_id = $reporter->getId();
            return $rep->save($this);
        }
        return $saved;
    }

    private function insertDirectMessage($data, $reporter) {
        if (!$reporter) return $this->repError('no reporter');

        $pubkey = $data['contact']['pubkey'] ?? null;
        if (!$pubkey) return $this->repError('no key');

        $contact = MeshLogContact::findBy("public_key", $pubkey, $this, array(), false, true);
        if (!$contact) {
            $contact = MeshLogContact::fromJson($data, $this);
            if (!$contact->save($this)) return $this->repError('failed to save contact');
        }

        $dm = MeshLogDirectMessage::fromJson($data, $this);
        $dm->contact_ref = $contact;

        // Time grouping
        // Can't use sent_at. Device after reboot might send advert
        // with bad date, making hash duplicate with older messages
        $minage = date("Y-m-d H:i:s", time() -  $this->getConfig(MeshlogSetting::KEY_MAX_GROUPING_AGE));
        $existing = MeshLogDirectMessage::findBy(
            "hash",
            $dm->hash,
            $this,
            array('created_at' => array('operator' => '>', 'value' => $minage)),
            false,
            true
        );

        if ($existing) {
            $dm = $existing;
            $saved = true;
        } else {
            $saved = $dm->save($this);
            $contact->updateHeardAt($this);
        }

        if ($saved) {
            // add report
            $rep = MeshLogDirectMessageReport::fromJson($data, $this);
            $rep->object_id = $dm->getId();
            $rep->reporter_id = $reporter->getId();
            return $rep->save($this);
        }
        return $saved;
    }

    private function insertGroupMessage($data, $reporter) {
        if (!$reporter) return $this->repError('no reporter');

        $hash = $data['channel']['hash'] ?? '11';
        $text = $data['message']['text'] ?? null;
        
        if (!$text) return $this->repError('no message');
        $name = explode(':', $text, 2)[0];

        $channel = MeshLogChannel::findBy("hash", $hash, $this, array(), false, true);

        if (!$channel) {
            $channel = MeshLogChannel::fromJson($data, $this);
            if (!$channel->save($this)) return $this->repError('failed to save channel');
        }

        $advertisement = MeshLogAdvertisement::findBy("name", $name, $this, array(), true, true);
        $contact = null;
        if ($advertisement) $contact = MeshLogContact::findById($advertisement->contact_ref->getId(), $this);

        $grpmsg = MeshLogChannelMessage::fromJson($data, $this);
        $grpmsg->contact_ref = $contact;
        $grpmsg->channel_ref = $channel;

        // Time grouping
        // Can't use sent_at. Device after reboot might send advert
        // with bad date, making hash duplicate with older messagesq
        $minage = date("Y-m-d H:i:s", time() -  $this->getConfig(MeshlogSetting::KEY_MAX_GROUPING_AGE));
        $existing = MeshLogChannelMessage::findBy("hash", $grpmsg->hash, $this, array('created_at' => array('operator' => '>', 'value' => $minage)));

        if ($existing) {
            $grpmsg = $existing;
            $saved = true;
        } else {
            $saved = $grpmsg->save($this);
            if ($contact) $contact->updateHeardAt($this);
        }

        if ($saved) {
            // add report
            $rep = MeshLogChannelMessageReport::fromJson($data, $this);
            $rep->object_id = $grpmsg->getId();
            $rep->reporter_id = $reporter->getId();
            return $rep->save($this);
        }
        return $saved;
    }

    private function writeInfluxDb($line) {
        $influxHost = $this->getConfig(MeshlogSetting::KEY_INFLUXDB_URL, "");
        $database   = $this->getConfig(MeshlogSetting::KEY_INFLUXDB_DB, ""); 

        if (empty($influxHost) || empty($database)) return;

        $url = "$influxHost/write?db=" . urlencode($database);

        // Initialize cURL
        $ch = curl_init($url);
        curl_setopt($ch, CURLOPT_POST, 1);
        curl_setopt($ch, CURLOPT_POSTFIELDS, $line);
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);

        $response = curl_exec($ch);
        $httpcode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        if ($httpcode >= 400) {
            return "Error $httpcode: $response for request $line";
        }

        return "";
    }

    private function insertTelemetry($data, $reporter) {
        if (!$reporter) return $this->repError('no reporter');

        $pubkey = $data['contact']['pubkey'] ?? null;
        if (!$pubkey) return $this->repError('no key');

        $contact = MeshLogContact::findBy("public_key", $pubkey, $this);

        if (!$contact) {
            return $this->repError('contact doesnt exist');
        }

        $tel = MeshLogTelemetry::fromJson($data, $this);
        $tel->reporter_ref = $reporter;
        $tel->contact_ref = $contact;

        $cname = str_replace(
            " ",
            "\\ ",
            $contact->name
        );

        $cname = str_replace("\"", "", $cname);

        $res = $tel->save($this);
        if ($res) {
            $errors = "";

            $data = json_decode($tel->data, true);
            foreach ($data as $chan) {
                if ($chan['type'] != "0") {
                    $ch = $chan['channel'];
                    $ty = $chan['type'];
                    $na = $chan['name'];
                    $va = $chan['value'];

                    $line = "mc_$na,contact=$pubkey,type=$ty,ch=$ch,name=$cname value=$va";
                    $error = $this->writeInfluxDb($line);
                    if (!empty($error)) {
                        $errors .= $error . "\n";
                    }
                }
            }

            if (!empty($errors)) {
                return $this->repError($errors);
            }
        } else {
            return $this->repError('failed to write db');
        }

        return $res;
    }

    private function insertRawPacket($data, $reporter, $decode=false) {
        if (!$reporter) return $this->repError('no reporter');

        $pkt = MeshLogRawPacket::fromJson($data, $this);
        $pkt->reporter_id = $reporter->getId();
        $saved = $pkt->save($this);

        if (!$decode || !$saved) return $saved;

        $path = strtoupper(str_replace(',', '', (string) $pkt->path));
        $hashSize = intval($pkt->hash_size);
        if ($hashSize < 1 || $hashSize > 3) return $saved;
        if ($path !== '' && (!ctype_xdigit($path) || (strlen($path) % 2) !== 0)) return $saved;

        $pathBytes = hex2bin($path);
        if ($pathBytes === false) return $saved;
        $pathLen = strlen($pathBytes);
        if (($pathLen % $hashSize) !== 0) return $saved;

        $hopCount = intval($pathLen / $hashSize);
        if ($hopCount > 63) return $saved;

        $payloadType = (intval($pkt->header) >> 2) & 0x0F;
        $decoderKeys = array();
        if ($payloadType === MeshLogMeshCoreDecoder::PAYLOAD_TYPE_GRP_TXT) {
            try {
                $stmt = $this->pdo->query("SELECT secret FROM channels WHERE enabled = 1 AND secret IS NOT NULL AND secret != ''");
                $decoderKeys['channel_secrets'] = $stmt->fetchAll(PDO::FETCH_COLUMN, 0);
            } catch (Throwable $e) {
                $decoderKeys['channel_secrets'] = array();
            }
        }

        $packet = chr(intval($pkt->header) & 0xFF)
            . chr((($hashSize - 1) << 6) | $hopCount)
            . $pathBytes
            . $pkt->payload;
        $decoded = meshlog_decode_emshcore_packet($packet, $decoderKeys);
        if (!($decoded['ok'] ?? false)) return $saved;

        $pkt->decoded = 1;
        $pkt->save($this);

        $doc = array(
            'version' => 1,
            'hash' => $data['hash'] ?? null,
            'hash_size' => $hashSize,
            'snr' => $pkt->snr,
            'time' => array(
                'local' => $data['time']['local'] ?? null,
            ),
            'message' => array(
                'path' => $pkt->path,
            ),
        );

        if (($decoded['payload_type'] ?? null) === MeshLogMeshCoreDecoder::PAYLOAD_TYPE_ADVERT) {
            $payload = $decoded['payload'] ?? array();
            $appData = $payload['app_data'] ?? array();
            if (!isset($payload['public_key'], $payload['timestamp'])) return $saved;

            $doc['type'] = 'ADV';
            $doc['time']['sender'] = intval($payload['timestamp']);
            $doc['contact'] = array(
                'pubkey' => $payload['public_key'],
                'name' => $appData['name'] ?? '',
                'lat' => intval(round(($appData['latitude'] ?? 0) * 1000000)),
                'lon' => intval(round(($appData['longitude'] ?? 0) * 1000000)),
                'type' => intval($appData['role'] ?? 0),
                'flags' => intval($appData['flags'] ?? 0),
            );
            return $this->insertAdvertisement($doc, $reporter);
        }

        if (($decoded['payload_type'] ?? null) === MeshLogMeshCoreDecoder::PAYLOAD_TYPE_GRP_TXT) {
            $payload = $decoded['payload']['decrypted'] ?? null;
            $channelHash = $decoded['payload']['channel_hash'] ?? null;
            if (!is_array($payload) || !isset($payload['message'], $payload['timestamp']) || !$channelHash) return $saved;

            $doc['type'] = 'PUB';
            $doc['time']['sender'] = intval($payload['timestamp']);
            $doc['channel'] = array(
                'hash' => $channelHash,
            );
            $doc['message']['text'] = $payload['message'];
            return $this->insertGroupMessage($doc, $reporter);
        }

        return $saved;
    }

    private function array_path(array $array, string $path, $default = null) {
        $keys = explode('.', $path);
        $current = $array;

        foreach ($keys as $key) {
            if (!is_array($current) || !array_key_exists($key, $current)) {
                return $default;
            }
            $current = $current[$key];
        }

        return $current;
    }

    private function appendInfluxDbLine($key, $val, $first=false) {
        if ($val === null) return "";
        $str = $first ? '' : ',';
        $str .= $key . "=" . $val;
        return $str;
    }

    private function insertSelfReport($data, $reporter) {
        if (!$reporter) return;
        if (!$data['contact'] || !$data['sys']) return;

        $lat = $data['contact']['lat'] ?? null;
        $lon = $data['contact']['lon'] ?? null;

        $vdata = array(
            "version" => $data['sys']['version'] ?? null
        );

        $reporter->updateLocation($this, $lat, $lon, $vdata);

        $pubkey = $data['contact']['pubkey'];
        $heap_total = $data['sys']['heap_total'];
        $heap_free = $data['sys']['heap_free'];
        $rssi = $data['sys']['rssi'];
        $uptime = $data['sys']['uptime'];

        $cname = str_replace(
            " ",
            "\\ ",
            $data['contact']['name']
        );

        $cname = str_replace("\"", "", $cname);

        $line = "mc_reporter,contact=$pubkey,name=$cname heap_total=$heap_total,heap_free=$heap_free,rssi=$rssi,uptime=$uptime";
        $line .= $this->appendInfluxDbLine("tx_packets", $this->array_path($data, 'sys.stats.tx.packets'));
        $line .= $this->appendInfluxDbLine("tx_packets_total", $this->array_path($data, 'sys.stats.tx.packets_total'));
        $line .= $this->appendInfluxDbLine("tx_air_time", $this->array_path($data, 'sys.stats.tx.air_time'));
        $line .= $this->appendInfluxDbLine("tx_air_time_total", $this->array_path($data, 'sys.stats.tx.air_time_total'));
        $line .= $this->appendInfluxDbLine("tx_air_time_duty", $this->array_path($data, 'sys.stats.tx.air_time_duty'));

        $line .= $this->appendInfluxDbLine("rx_packets", $this->array_path($data, 'sys.stats.rx.packets'));
        $line .= $this->appendInfluxDbLine("rx_packets_total", $this->array_path($data, 'sys.stats.rx.packets_total'));
        $line .= $this->appendInfluxDbLine("rx_air_time", $this->array_path($data, 'sys.stats.rx.air_time'));
        $line .= $this->appendInfluxDbLine("rx_air_time_total", $this->array_path($data, 'sys.stats.rx.air_time_total'));
        $line .= $this->appendInfluxDbLine("rx_air_time_duty", $this->array_path($data, 'sys.stats.rx.air_time_duty'));

        $error = $this->writeInfluxDb($line);
    }

    private function repError($msg) {
        return array('error' => $msg);
    }

    // getters
    public function getReporters($params) {
        $params['where'] = array(
            'authorized = 1'
        );
        $results = MeshLogReporter::getAll($this, $params);

        // find contact
        $out = [];
        foreach ($results['objects'] as $k => $r) {
            $pk = $r["public_key"];
            $c = MeshLogContact::findBy("public_key", $pk, $this, array());
            if ($c) {
                $r['contact_id'] = $c->getId();
                $r['contact'] = $c->asArray();
            }
            $out[] = $r;
        }

        return array("objects" => $out);
    }

    public function getContacts($params, $adv=FALSE) {
        $params['where'] = array(
            'enabled = 1'
        );

        $results = MeshLogContact::getAll($this, $params);
        $out = [];
        $maxage = isset($params['max_age']) ? $params['max_age'] : 0;

        if ($params['advertisements'] || $maxage) {
            foreach ($results['objects'] as $k => $c) {
                $id = $c['id'];

                if ($params['telemetry']) {
                    $tel = MeshLogTelemetry::findBy("contact_id", $id, $this, array('created_at' => array('operator' => '>', 'value' => $maxage)));
                    if ($tel) {
                        $c['telemetry'] = json_decode($tel->data);
                    }
                }

                $ad = MeshLogAdvertisement::findBy("contact_id", $id, $this, array('created_at' => array('operator' => '>', 'value' => $maxage)));
                if ($ad) {
                    $c['advertisement'] = $ad->asArray();
                    $out[] = $c;
                }
            }
        }

        return array("objects" => $out);
    }

    public function addReports($results, $klass) {
        foreach ($results['objects'] as $key => $val) {
            $id = $val['id'];

            $outrep = array();
            $reports = $klass::getAllReports($this, $id);
            foreach ($reports['objects'] as $rkey => $rval) {
                $outrep[] = $rval;
            }

            $results['objects'][$key]['reports'] = $outrep;
        }
        return $results;
    }

    public function getAdvertisements($params, $reports = false) {
        $params['where'] = array();
        $results = MeshLogAdvertisement::getAll($this, $params);

        if ($reports) {
            $results = $this->addReports($results, 'MeshLogAdvertisementReport');
        }

        return $results;
    }

    public function getChannels($params) {
        $params['where'] = array('enabled = 1');
        return MeshLogChannel::getAll($this, $params);
    }

    private function getQuickSql($tklass, $rklass, $extra1='') {
        $tfields = $tklass::getPublicFields();
        $ttable = $tklass::getTable();
        $rtable = $rklass::getTable();
        $rrefname = $rklass::getRefName();

        $sql = "
            SELECT
                $tfields,
                GREATEST(t.created_at, COALESCE(MAX(r.created_at), t.created_at)) AS activity_at,
                JSON_ARRAYAGG(
                        JSON_OBJECT(
                            'id', r.id,
                            'reporter_id', r.reporter_id,
                            'snr', r.snr,
                            'path', r.path,
                            'received_at', r.received_at,
                            'created_at', r.created_at
                        )
                ) AS reports
            FROM (
                SELECT t.* FROM $ttable t
                $extra1
                ORDER BY t.id DESC
                LIMIT :offset,:limit
            ) t
            LEFT JOIN $rtable r ON r.$rrefname = t.id
            GROUP BY t.id
            ORDER BY t.id DESC
        ";

        return $sql;
    }

    private function getTimeFiltersSql($params, $alias = 't', $suffix = '') {
        $after_ms = $params['after_ms'] ?? 0;
        $before_ms = $params['before_ms'] ?? 0;

        $binds = [];
        $sqlWhere = "";
        $afterParam = ':after_ms' . $suffix;
        $beforeParam = ':before_ms' . $suffix;
        if ($after_ms > 0) {
            $after_ms = floor($after_ms / 1000);
            $sqlWhere = "$alias.created_at > FROM_UNIXTIME($afterParam) ";
            $binds[] = array($afterParam, $after_ms, PDO::PARAM_INT);
        }
        if ($before_ms > 0) {
            $before_ms = floor($before_ms / 1000);
            if (strlen($sqlWhere)) {
                $sqlWhere .= " AND $alias.created_at < FROM_UNIXTIME($beforeParam)";
            } else {
                $sqlWhere = "$alias.created_at < FROM_UNIXTIME($beforeParam)";
            }
            $binds[] = array($beforeParam, $before_ms, PDO::PARAM_INT);
        }

        return array($sqlWhere, $binds);
    }

    public function getRecentMessageIds($params) {
        $limit = (int) ($params['count'] ?? DEFAULT_COUNT);
        $includeAdvertisements = !array_key_exists('include_advertisements', $params) || (int) $params['include_advertisements'] !== 0;
        $includeChannelMessages = !array_key_exists('include_channel_messages', $params) || (int) $params['include_channel_messages'] !== 0;
        $includeDirectMessages = !array_key_exists('include_direct_messages', $params) || (int) $params['include_direct_messages'] !== 0;
        $after_ms = (int) ($params['after_ms'] ?? 0);
        $before_ms = (int) ($params['before_ms'] ?? 0);

        if ($limit < 1) {
            return array(
                'advertisements' => array(),
                'channel_messages' => array(),
                'direct_messages' => array(),
            );
        }
        if ($limit > MAX_COUNT) {
            $limit = MAX_COUNT;
        }

        $binds = array();
        $queries = array();
        if ($includeAdvertisements) {
            $queries[] = array(
                'type' => 'advertisements',
                'suffix' => '_advertisements',
                'sql' => "
                    SELECT 'advertisements' AS message_type, recent.id, recent.activity_at
                    FROM (
                        SELECT
                            a.id,
                            GREATEST(a.created_at, COALESCE(MAX(ar.created_at), a.created_at)) AS activity_at
                        FROM advertisements a
                        LEFT JOIN advertisement_reports ar ON ar.advertisement_id = a.id
                        GROUP BY a.id
                    ) recent
                ",
            );
        }
        if ($includeChannelMessages) {
            $queries[] = array(
                'type' => 'channel_messages',
                'suffix' => '_channel_messages',
                'sql' => "
                    SELECT 'channel_messages' AS message_type, recent.id, recent.activity_at
                    FROM (
                        SELECT
                            cm.id,
                            GREATEST(cm.created_at, COALESCE(MAX(cmr.created_at), cm.created_at)) AS activity_at
                        FROM channel_messages cm
                        JOIN channels c ON c.id = cm.channel_id AND c.enabled = 1
                        LEFT JOIN channel_message_reports cmr ON cmr.channel_message_id = cm.id
                        GROUP BY cm.id
                    ) recent
                ",
            );
        }
        if ($includeDirectMessages) {
            $queries[] = array(
                'type' => 'direct_messages',
                'suffix' => '_direct_messages',
                'sql' => "
                    SELECT 'direct_messages' AS message_type, recent.id, recent.activity_at
                    FROM (
                        SELECT
                            dm.id,
                            GREATEST(dm.created_at, COALESCE(MAX(dmr.created_at), dm.created_at)) AS activity_at
                        FROM direct_messages dm
                        LEFT JOIN direct_message_reports dmr ON dmr.direct_message_id = dm.id
                        GROUP BY dm.id
                    ) recent
                ",
            );
        }

        if (!count($queries)) {
            return array(
                'advertisements' => array(),
                'channel_messages' => array(),
                'direct_messages' => array(),
            );
        }

        $parts = array();
        foreach ($queries as $query) {
            $sql = $query['sql'];

            $filters = array();
            if ($after_ms > 0) {
                $afterParam = ':after_ms' . $query['suffix'];
                $filters[] = "recent.activity_at > FROM_UNIXTIME($afterParam)";
                $binds[] = array($afterParam, floor($after_ms / 1000), PDO::PARAM_INT);
            }
            if ($before_ms > 0) {
                $beforeParam = ':before_ms' . $query['suffix'];
                $filters[] = "recent.activity_at < FROM_UNIXTIME($beforeParam)";
                $binds[] = array($beforeParam, floor($before_ms / 1000), PDO::PARAM_INT);
            }

            if (count($filters)) {
                $sql .= " WHERE " . implode(' AND ', $filters);
            }

            $parts[] = $sql;
        }

        $sql = "
            SELECT message_type, id
            FROM (
                " . implode("
                UNION ALL
                ", $parts) . "
            ) recent_messages
            ORDER BY activity_at DESC, id DESC
            LIMIT :limit
        ";

        $stmt = $this->pdo->prepare($sql);
        $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
        foreach ($binds as $bind) {
            $stmt->bindValue($bind[0], $bind[1], $bind[2]);
        }
        $stmt->execute();

        $results = array(
            'advertisements' => array(),
            'channel_messages' => array(),
            'direct_messages' => array(),
        );

        while ($row = $stmt->fetch(PDO::FETCH_ASSOC)) {
            $type = $row['message_type'];
            if (!isset($results[$type])) {
                continue;
            }
            $results[$type][] = (int) $row['id'];
        }

        return $results;
    }

    public function getReportedQuick($params, $tklass, $rklass, $extra, $binds) {
        $offset = (int) ($params['offset'] ?? 0);
        $limit = (int) ($params['count'] ?? DEFAULT_COUNT);
        $where = $this->getTimeFiltersSql($params);
        $filters = array();
        if (!empty($where[0])) {
            $filters[] = $where[0];
            foreach ($where[1] as $w) {
                $binds[] = $w;
            }
        }

        $ids = $params['ids'] ?? array();
        if (is_array($ids) && count($ids)) {
            $placeholders = array();
            foreach (array_values($ids) as $index => $id) {
                $param = ':id_' . $index;
                $placeholders[] = $param;
                $binds[] = array($param, (int) $id, PDO::PARAM_INT);
            }
            $filters[] = 't.id IN (' . implode(',', $placeholders) . ')';
        }

        if (count($filters)) {
            $extra .= " WHERE " . implode(' AND ', $filters);
        }

        if ($limit > MAX_COUNT) $limit = MAX_COUNT;

        $sql = $this->getQuickSql(
            $tklass,
            $rklass,
            $extra
        );

        $stmt = $this->pdo->prepare($sql);
        $stmt->bindValue(':offset', $offset, PDO::PARAM_INT);
        $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);

        foreach ($binds as $b) {
            $stmt->bindValue($b[0], $b[1], $b[2]);
        }

        $stmt->execute();

        $results = [];
        while ($row = $stmt->fetch(PDO::FETCH_ASSOC)) {
            $row['reports'] = json_decode($row['reports'], true);
            $results[] = $row;
        }

        return array("objects" => $results);
    }

    public function getChannelMessagesQuick($params) {
        $channel_id = $params['channel_id'] ?? null;
        $extra = "JOIN channels c ON c.id = t.channel_id AND c.enabled = 1 ";
        $binds = array();

        if ($channel_id !== null) {
            $binds[] = array(':channel_id', (int) $channel_id, PDO::PARAM_INT);
        }

        return $this->getReportedQuick(
            $params,
            'MeshLogChannelMessage',
            'MeshLogChannelMessageReport',
            $extra,
            $binds
        );
    }

    public function getDirectMessagesQuick($params) {
        return $this->getReportedQuick(
            $params,
            'MeshLogDirectMessage',
            'MeshLogDirectMessageReport',
            "",
            array()
        );
    }

    public function getAdvertisementsQuick($params) {
        return $this->getReportedQuick(
            $params,
            'MeshLogAdvertisement',
            'MeshLogAdvertisementReport',
            "",
            array()
        );
    }

    private function buildIntInClause($values, $prefix = 'id') {
        $placeholders = array();
        $binds = array();

        foreach (array_values($values) as $index => $value) {
            $param = ':' . $prefix . '_' . $index;
            $placeholders[] = $param;
            $binds[] = array($param, (int) $value, PDO::PARAM_INT);
        }

        return array($placeholders, $binds);
    }

    public function getContactsQuick($params) {
        $maxage = $this->getConfig(MeshlogSetting::KEY_MAX_CONTACT_AGE);
        $offset = (int) ($params['offset'] ?? 0);
        $limit = (int) ($params['count'] ?? DEFAULT_COUNT);
        $includeTelemetry = (int) ($params['telemetry'] ?? ($params['include_telemetry'] ?? 0)) !== 0;
        $extra = "WHERE last_heard_at >= NOW() - INTERVAL $maxage SECOND ";
        $binds = array();
        $where = $this->getTimeFiltersSql($params);
        if (!empty($where[0])) {
            $extra .= " AND " . $where[0];
            foreach ($where[1] as $w) {
                $binds[] = $w;
            }
        }

        $sql = "
            SELECT
                t.id,
                t.public_key,
                t.name,
                t.hash_size,
                t.multibyte,
                t.last_heard_at,
                t.created_at
            FROM contacts t
            $extra
            ORDER BY t.id DESC
            LIMIT :offset,:limit
        ";

        $stmt = $this->pdo->prepare($sql);
        $stmt->bindValue(':offset', $offset, PDO::PARAM_INT);
        $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);

        foreach ($binds as $b) {
            $stmt->bindValue($b[0], $b[1], $b[2]);
        }

        $stmt->execute();

        $results = $stmt->fetchAll(PDO::FETCH_ASSOC);
        if (!count($results)) {
            return array("objects" => array());
        }

        $contactIds = array_map(function($row) {
            return (int) $row['id'];
        }, $results);

        $inClause = $this->buildIntInClause($contactIds, 'contact_id');
        $contactIdPlaceholders = implode(',', $inClause[0]);
        $contactIdBinds = $inClause[1];

        $reporterIdsByContact = array();
        $reportersSql = "
            SELECT
                a.contact_id,
                COALESCE(JSON_ARRAYAGG(DISTINCT ar.reporter_id), JSON_ARRAY()) AS reporter_ids
            FROM advertisements a
            JOIN advertisement_reports ar ON ar.advertisement_id = a.id
            WHERE a.contact_id IN ($contactIdPlaceholders)
            GROUP BY a.contact_id
        ";
        $reportersStmt = $this->pdo->prepare($reportersSql);
        foreach ($contactIdBinds as $bind) {
            $reportersStmt->bindValue($bind[0], $bind[1], $bind[2]);
        }
        $reportersStmt->execute();
        while ($row = $reportersStmt->fetch(PDO::FETCH_ASSOC)) {
            $reporterIdsByContact[(int) $row['contact_id']] = json_decode($row['reporter_ids'], true) ?? array();
        }

        $advertisementMetaByContact = array();
        $advertisementMetaSql = "
            SELECT
                a.contact_id,
                SUBSTRING_INDEX(
                    GROUP_CONCAT(
                        UNIX_TIMESTAMP(a.created_at)
                        ORDER BY a.id DESC SEPARATOR ','
                    ),
                    ',',
                    2
                ) AS recent_created_at
            FROM advertisements a
            WHERE a.contact_id IN ($contactIdPlaceholders)
                AND EXISTS (
                    SELECT 1
                    FROM advertisement_reports ar
                    WHERE ar.advertisement_id = a.id
                        AND TRIM(COALESCE(ar.path, '')) <> ''
                        AND LOWER(TRIM(ar.path)) <> 'direct'
                )
            GROUP BY a.contact_id
        ";
        $advertisementMetaStmt = $this->pdo->prepare($advertisementMetaSql);
        foreach ($contactIdBinds as $bind) {
            $advertisementMetaStmt->bindValue($bind[0], $bind[1], $bind[2]);
        }
        $advertisementMetaStmt->execute();
        while ($row = $advertisementMetaStmt->fetch(PDO::FETCH_ASSOC)) {
            $intervalSeconds = null;
            $recentCreatedAt = explode(',', strval($row['recent_created_at'] ?? ''));
            if (count($recentCreatedAt) >= 2) {
                $latestTs = intval($recentCreatedAt[0]);
                $previousTs = intval($recentCreatedAt[1]);
                if ($latestTs > 0 && $previousTs > 0 && $latestTs >= $previousTs) {
                    $intervalSeconds = $latestTs - $previousTs;
                }
            }

            $advertisementMetaByContact[(int) $row['contact_id']] = array(
                'interval_seconds' => $intervalSeconds,
            );
        }

        $advertisementsByContact = array();
        $advertisementsSql = "
            SELECT
                a.contact_id,
                JSON_OBJECT(
                    'id', a.id,
                    'hash', a.hash,
                    'name', a.name,
                    'lat', a.lat,
                    'lon', a.lon,
                    'type', a.type,
                    'flags', a.flags,
                    'sent_at', a.sent_at,
                    'created_at', a.created_at
                ) AS advertisement
            FROM advertisements a
            JOIN (
                SELECT contact_id, MAX(id) AS latest_id
                FROM advertisements
                WHERE contact_id IN ($contactIdPlaceholders)
                GROUP BY contact_id
            ) latest ON latest.latest_id = a.id
        ";
        $advertisementsStmt = $this->pdo->prepare($advertisementsSql);
        foreach ($contactIdBinds as $bind) {
            $advertisementsStmt->bindValue($bind[0], $bind[1], $bind[2]);
        }
        $advertisementsStmt->execute();
        while ($row = $advertisementsStmt->fetch(PDO::FETCH_ASSOC)) {
            $contactId = (int) $row['contact_id'];
            $advertisement = json_decode($row['advertisement'], true);
            if (is_array($advertisement)) {
                $advertisement['interval_seconds'] = $advertisementMetaByContact[$contactId]['interval_seconds'] ?? null;
            }
            $advertisementsByContact[$contactId] = $advertisement;
        }

        $telemetryByContact = array();
        if ($includeTelemetry) {
            $telemetrySql = "
                SELECT
                    l.contact_id,
                    l.data AS telemetry
                FROM telemetry l
                JOIN (
                    SELECT contact_id, MAX(id) AS id
                    FROM telemetry
                    WHERE contact_id IN ($contactIdPlaceholders)
                    GROUP BY contact_id
                ) latest ON latest.id = l.id
            ";
            $telemetryStmt = $this->pdo->prepare($telemetrySql);
            foreach ($contactIdBinds as $bind) {
                $telemetryStmt->bindValue($bind[0], $bind[1], $bind[2]);
            }
            $telemetryStmt->execute();
            while ($row = $telemetryStmt->fetch(PDO::FETCH_ASSOC)) {
                $telemetryByContact[(int) $row['contact_id']] = json_decode($row['telemetry'], true);
            }
        }

        foreach ($results as &$row) {
            $contactId = (int) $row['id'];
            $row['reporter_ids'] = $reporterIdsByContact[$contactId] ?? array();
            $row['advertisement'] = $advertisementsByContact[$contactId] ?? null;
            $row['telemetry'] = $telemetryByContact[$contactId] ?? null;
        }
        unset($row);

        return array("objects" => $results);

    }

    public function getChannelMessages($params, $reports = false) {
        $params['where'] = array();
        if (isset($params['id'])) {
            $ch = MeshLogChannel::findById(intval($id), $this);
            if (!$ch->enabled) return array();
            $params['where'] = array('channel_id = ' . intval($id));
        } else {
            $params['join'] = 'JOIN channels  ON t.channel_id = channels.id';
            $params['where'] = array('channels.enabled = 1');
        }

        $results = MeshLogChannelMessage::getAll($this, $params);

        if ($reports) {
            $results = $this->addReports($results, 'MeshLogChannelMessageReport');
        }

        return $results;
    }

    public function getDirectMessages($params, $reports = false) {
        $params['where'] = array();
        if (isset($params['id'])) {
            $params['where'] = array('contact_id = ' . intval($id));
        }

        $results = MeshLogDirectMessage::getAll($this, $params);

        if ($reports) {
            $results = $this->addReports($results, 'MeshLogDirectMessageReport');
        }

        return $results;
    }

    public function getRawPackets($params) {
        $params['where'] = array();
        $results = MeshLogRawPacket::getAll($this, $params);
        return $results;
    }
};

?>

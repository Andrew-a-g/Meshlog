<?php

function meshlog_decode_emshcore_packet($packet, array $keys = array()) {
    return MeshLogMeshCoreDecoder::decode($packet, $keys);
}

class MeshLogMeshCoreDecoder {
    const ROUTE_TYPE_TRANSPORT_FLOOD = 0x00;
    const ROUTE_TYPE_FLOOD = 0x01;
    const ROUTE_TYPE_DIRECT = 0x02;
    const ROUTE_TYPE_TRANSPORT_DIRECT = 0x03;

    const PAYLOAD_TYPE_REQ = 0x00;
    const PAYLOAD_TYPE_RESPONSE = 0x01;
    const PAYLOAD_TYPE_TXT_MSG = 0x02;
    const PAYLOAD_TYPE_ACK = 0x03;
    const PAYLOAD_TYPE_ADVERT = 0x04;
    const PAYLOAD_TYPE_GRP_TXT = 0x05;
    const PAYLOAD_TYPE_GRP_DATA = 0x06;
    const PAYLOAD_TYPE_ANON_REQ = 0x07;
    const PAYLOAD_TYPE_PATH = 0x08;
    const PAYLOAD_TYPE_TRACE = 0x09;
    const PAYLOAD_TYPE_MULTIPART = 0x0A;
    const PAYLOAD_TYPE_CONTROL = 0x0B;
    const PAYLOAD_TYPE_RAW_CUSTOM = 0x0F;

    private static $routeNames = array(
        self::ROUTE_TYPE_TRANSPORT_FLOOD => 'transport_flood',
        self::ROUTE_TYPE_FLOOD => 'flood',
        self::ROUTE_TYPE_DIRECT => 'direct',
        self::ROUTE_TYPE_TRANSPORT_DIRECT => 'transport_direct',
    );

    private static $payloadNames = array(
        self::PAYLOAD_TYPE_REQ => 'request',
        self::PAYLOAD_TYPE_RESPONSE => 'response',
        self::PAYLOAD_TYPE_TXT_MSG => 'text_message',
        self::PAYLOAD_TYPE_ACK => 'ack',
        self::PAYLOAD_TYPE_ADVERT => 'advert',
        self::PAYLOAD_TYPE_GRP_TXT => 'group_text',
        self::PAYLOAD_TYPE_GRP_DATA => 'group_data',
        self::PAYLOAD_TYPE_ANON_REQ => 'anon_request',
        self::PAYLOAD_TYPE_PATH => 'path',
        self::PAYLOAD_TYPE_TRACE => 'trace',
        self::PAYLOAD_TYPE_MULTIPART => 'multipart',
        self::PAYLOAD_TYPE_CONTROL => 'control',
        self::PAYLOAD_TYPE_RAW_CUSTOM => 'raw_custom',
    );

    private static $requestNames = array(
        0x01 => 'get_stats',
        0x02 => 'keepalive',
        0x03 => 'get_telemetry',
        0x04 => 'get_min_max_avg',
        0x05 => 'get_access_list',
        0x06 => 'get_neighbours',
        0x07 => 'get_owner_info',
    );

    public static function decode($packet, array $keys = array()) {
        $raw = self::normalizeBytes($packet);
        if ($raw === false || $raw === '') {
            return array(
                'ok' => false,
                'error' => 'invalid packet data',
            );
        }

        $length = strlen($raw);
        if ($length < 2) {
            return array(
                'ok' => false,
                'error' => 'packet too short',
                'raw_hex' => strtoupper(bin2hex($raw)),
                'length' => $length,
            );
        }

        $offset = 0;
        $header = ord($raw[$offset++]);
        $routeType = $header & 0x03;
        $payloadType = ($header >> 2) & 0x0F;
        $version = ($header >> 6) & 0x03;

        $decoded = array(
            'ok' => true,
            'raw_hex' => strtoupper(bin2hex($raw)),
            'length' => $length,
            'header' => $header,
            'header_hex' => strtoupper(sprintf('%02x', $header)),
            'version' => $version,
            'route_type' => $routeType,
            'route_name' => self::lookup(self::$routeNames, $routeType, 'unknown'),
            'payload_type' => $payloadType,
            'payload_name' => self::lookup(self::$payloadNames, $payloadType, 'unknown'),
        );

        if ($routeType === self::ROUTE_TYPE_TRANSPORT_FLOOD || $routeType === self::ROUTE_TYPE_TRANSPORT_DIRECT) {
            if ($offset + 4 > $length) {
                return self::failDecode($decoded, 'packet missing transport codes');
            }

            $decoded['transport_codes'] = array(
                'raw_hex' => strtoupper(bin2hex(substr($raw, $offset, 4))),
                'transport_code_1' => self::u16le(substr($raw, $offset, 2)),
                'transport_code_2' => self::u16le(substr($raw, $offset + 2, 2)),
            );
            $offset += 4;
        }

        if ($offset >= $length) {
            return self::failDecode($decoded, 'packet missing path length');
        }

        $pathMeta = ord($raw[$offset++]);
        $hopCount = $pathMeta & 0x3F;
        $hashSizeCode = ($pathMeta >> 6) & 0x03;
        $hashSize = $hashSizeCode + 1;
        $pathSize = $hopCount * $hashSize;

        $decoded['path'] = array(
            'meta' => $pathMeta,
            'meta_hex' => strtoupper(sprintf('%02x', $pathMeta)),
            'hop_count' => $hopCount,
            'hash_size' => $hashSize,
        );

        if ($hashSizeCode === 0x03) {
            $decoded['path']['invalid_hash_size'] = true;
        }

        if ($offset + $pathSize > $length) {
            return self::failDecode($decoded, 'packet path exceeds packet length');
        }

        $pathBytes = substr($raw, $offset, $pathSize);
        $offset += $pathSize;

        $decoded['path']['raw_hex'] = strtoupper(bin2hex($pathBytes));
        $decoded['path']['hashes'] = self::splitHashes($pathBytes, $hashSize);

        $payload = substr($raw, $offset);
        $decoded['payload_hex'] = strtoupper(bin2hex($payload));

        $keyring = self::prepareKeys($keys);
        $decoded['payload'] = self::decodePayload($payloadType, $payload, $decoded, $keyring);

        return $decoded;
    }

    private static function failDecode(array $decoded, $error) {
        $decoded['ok'] = false;
        $decoded['error'] = $error;
        return $decoded;
    }

    private static function decodePayload($payloadType, $payload, array $packet, array $keyring) {
        switch ($payloadType) {
            case self::PAYLOAD_TYPE_ADVERT:
                return self::decodeAdvertPayload($payload);
            case self::PAYLOAD_TYPE_ACK:
                return self::decodeAckPayload($payload);
            case self::PAYLOAD_TYPE_CONTROL:
                return self::decodeControlPayload($payload);
            case self::PAYLOAD_TYPE_GRP_TXT:
                return self::decodeGroupPayload($payload, $keyring, true);
            case self::PAYLOAD_TYPE_GRP_DATA:
                return self::decodeGroupPayload($payload, $keyring, false);
            case self::PAYLOAD_TYPE_ANON_REQ:
                return self::decodeAnonRequestPayload($payload, $keyring);
            case self::PAYLOAD_TYPE_REQ:
            case self::PAYLOAD_TYPE_RESPONSE:
            case self::PAYLOAD_TYPE_TXT_MSG:
            case self::PAYLOAD_TYPE_PATH:
                return self::decodeDirectPayload($payloadType, $payload, $keyring);
            case self::PAYLOAD_TYPE_TRACE:
                return self::decodeTracePayload($payload, $packet['path']);
            default:
                return array(
                    'raw_hex' => strtoupper(bin2hex($payload)),
                );
        }
    }

    private static function decodeAdvertPayload($payload) {
        $length = strlen($payload);
        if ($length < 100) {
            return array(
                'raw_hex' => strtoupper(bin2hex($payload)),
                'error' => 'advert payload too short',
            );
        }

        $publicKey = substr($payload, 0, 32);
        $timestampBytes = substr($payload, 32, 4);
        $signature = substr($payload, 36, 64);
        $appData = substr($payload, 100);

        $decoded = array(
            'public_key' => strtoupper(bin2hex($publicKey)),
            'public_key_hash' => strtoupper(sprintf('%02x', ord($publicKey[0]))),
            'timestamp' => self::u32le($timestampBytes),
            'signature' => strtoupper(bin2hex($signature)),
            'app_data_hex' => strtoupper(bin2hex($appData)),
        );

        if (function_exists('sodium_crypto_sign_verify_detached')) {
            try {
                $decoded['signature_valid'] = sodium_crypto_sign_verify_detached(
                    $signature,
                    $publicKey . $timestampBytes . $appData,
                    $publicKey
                );
            } catch (Throwable $e) {
                $decoded['signature_valid'] = false;
            }
        }

        if ($appData !== '') {
            $decoded['app_data'] = self::decodeAdvertAppData($appData);
        }

        return $decoded;
    }

    private static function decodeAdvertAppData($appData) {
        $flags = ord($appData[0]);
        $offset = 1;
        $decoded = array(
            'flags' => $flags,
            'role' => $flags & 0x0F,
            'has_location' => (bool) ($flags & 0x10),
            'has_feature_1' => (bool) ($flags & 0x20),
            'has_feature_2' => (bool) ($flags & 0x40),
            'has_name' => (bool) ($flags & 0x80),
        );

        if (($flags & 0x10) && strlen($appData) >= $offset + 8) {
            $decoded['latitude'] = self::i32le(substr($appData, $offset, 4)) / 1000000.0;
            $decoded['longitude'] = self::i32le(substr($appData, $offset + 4, 4)) / 1000000.0;
            $offset += 8;
        }

        if (($flags & 0x20) && strlen($appData) >= $offset + 2) {
            $decoded['feature_1'] = self::u16le(substr($appData, $offset, 2));
            $offset += 2;
        }

        if (($flags & 0x40) && strlen($appData) >= $offset + 2) {
            $decoded['feature_2'] = self::u16le(substr($appData, $offset, 2));
            $offset += 2;
        }

        if (($flags & 0x80) && strlen($appData) > $offset) {
            $decoded['name'] = self::cleanText(substr($appData, $offset));
        }

        return $decoded;
    }

    private static function decodeAckPayload($payload) {
        return array(
            'checksum' => strlen($payload) >= 4 ? strtoupper(bin2hex(substr($payload, 0, 4))) : null,
            'raw_hex' => strtoupper(bin2hex($payload)),
        );
    }

    private static function decodeControlPayload($payload) {
        if ($payload === '') {
            return array('raw_hex' => '');
        }

        $flags = ord($payload[0]);
        $subType = ($flags >> 4) & 0x0F;
        $data = substr($payload, 1);
        $decoded = array(
            'flags' => $flags,
            'sub_type' => $subType,
            'data_hex' => strtoupper(bin2hex($data)),
        );

        if ($subType === 0x08 && strlen($data) >= 5) {
            $decoded['parsed'] = array(
                'sub_type_name' => 'DISCOVER_REQ',
                'prefix_only' => (bool) ($flags & 0x01),
                'type_filter' => ord($data[0]),
                'type_filter_hex' => strtoupper(sprintf('%02x', ord($data[0]))),
                'tag' => self::u32le(substr($data, 1, 4)),
                'tag_hex' => strtoupper(bin2hex(substr($data, 1, 4))),
            );
            if (strlen($data) >= 9) {
                $decoded['parsed']['since'] = self::u32le(substr($data, 5, 4));
            }
        } elseif ($subType === 0x09 && strlen($data) >= 5) {
            $snrRaw = self::i8($data[0]);
            $decoded['parsed'] = array(
                'sub_type_name' => 'DISCOVER_RESP',
                'node_type' => $flags & 0x0F,
                'snr_raw' => $snrRaw,
                'snr_db' => $snrRaw / 4.0,
                'tag' => self::u32le(substr($data, 1, 4)),
                'tag_hex' => strtoupper(bin2hex(substr($data, 1, 4))),
                'pubkey' => strtoupper(bin2hex(substr($data, 5))),
            );
        }

        return $decoded;
    }

    private static function decodeGroupPayload($payload, array $keyring, $isText) {
        if (strlen($payload) < 3) {
            return array(
                'raw_hex' => strtoupper(bin2hex($payload)),
                'error' => 'group payload too short',
            );
        }

        $channelHash = ord($payload[0]);
        $mac = substr($payload, 1, 2);
        $ciphertext = substr($payload, 3);

        $decoded = array(
            'channel_hash' => strtoupper(sprintf('%02x', $channelHash)),
            'cipher_mac' => strtoupper(bin2hex($mac)),
            'ciphertext_hex' => strtoupper(bin2hex($ciphertext)),
        );

        foreach ($keyring['channels'][$channelHash] as $candidate) {
            $plaintext = self::decryptCiphertext($ciphertext, $mac, $candidate['secret']);
            if ($plaintext === false) {
                continue;
            }

            $decoded['decryption_key'] = $candidate['secret_hex'];
            $decoded['decrypted_hex'] = strtoupper(bin2hex($plaintext));
            $decoded['decrypted'] = $isText
                ? self::decodeTextPlaintext($plaintext)
                : self::decodeGroupDataPlaintext($plaintext);
            return $decoded;
        }

        return $decoded;
    }

    private static function decodeAnonRequestPayload($payload, array $keyring) {
        if (strlen($payload) < 35) {
            return array(
                'raw_hex' => strtoupper(bin2hex($payload)),
                'error' => 'anon request payload too short',
            );
        }

        $destinationHash = ord($payload[0]);
        $senderPublicKey = substr($payload, 1, 32);
        $mac = substr($payload, 33, 2);
        $ciphertext = substr($payload, 35);

        $decoded = array(
            'destination_hash' => strtoupper(sprintf('%02x', $destinationHash)),
            'sender_public_key' => strtoupper(bin2hex($senderPublicKey)),
            'cipher_mac' => strtoupper(bin2hex($mac)),
            'ciphertext_hex' => strtoupper(bin2hex($ciphertext)),
        );

        foreach ($keyring['node_keys'][$destinationHash] as $nodeKey) {
            $sharedSecret = self::deriveSharedSecret($nodeKey['private_key'], $senderPublicKey);
            if ($sharedSecret === false) {
                continue;
            }

            $plaintext = self::decryptCiphertext($ciphertext, $mac, $sharedSecret);
            if ($plaintext === false) {
                continue;
            }

            $decoded['decryption_key'] = array(
                'public_key' => $nodeKey['public_key_hex'],
                'private_key' => $nodeKey['private_key_hex'],
            );
            $decoded['decrypted_hex'] = strtoupper(bin2hex($plaintext));
            $decoded['decrypted'] = self::decodeAnonRequestPlaintext($plaintext);
            return $decoded;
        }

        return $decoded;
    }

    private static function decodeDirectPayload($payloadType, $payload, array $keyring) {
        if (strlen($payload) < 4) {
            return array(
                'raw_hex' => strtoupper(bin2hex($payload)),
                'error' => 'direct payload too short',
            );
        }

        $destinationHash = ord($payload[0]);
        $sourceHash = ord($payload[1]);
        $mac = substr($payload, 2, 2);
        $ciphertext = substr($payload, 4);

        $decoded = array(
            'destination_hash' => strtoupper(sprintf('%02x', $destinationHash)),
            'source_hash' => strtoupper(sprintf('%02x', $sourceHash)),
            'cipher_mac' => strtoupper(bin2hex($mac)),
            'ciphertext_hex' => strtoupper(bin2hex($ciphertext)),
        );

        $privateCandidates = array_merge($keyring['node_keys'][$destinationHash], $keyring['node_keys'][$sourceHash]);
        foreach ($privateCandidates as $nodeKey) {
            $otherHash = $nodeKey['hash_byte'] === $destinationHash ? $sourceHash : $destinationHash;
            foreach ($keyring['public_keys'][$otherHash] as $publicKey) {
                $sharedSecret = self::deriveSharedSecret($nodeKey['private_key'], $publicKey['public_key']);
                if ($sharedSecret === false) {
                    continue;
                }

                $plaintext = self::decryptCiphertext($ciphertext, $mac, $sharedSecret);
                if ($plaintext === false) {
                    continue;
                }

                $decoded['decryption_key'] = array(
                    'private_public_key' => $nodeKey['public_key_hex'],
                    'peer_public_key' => $publicKey['public_key_hex'],
                );
                $decoded['decrypted_hex'] = strtoupper(bin2hex($plaintext));
                $decoded['decrypted'] = self::decodeDirectPlaintext($payloadType, $plaintext);
                return $decoded;
            }
        }

        return $decoded;
    }

    private static function decodeDirectPlaintext($payloadType, $plaintext) {
        switch ($payloadType) {
            case self::PAYLOAD_TYPE_REQ:
                return self::decodeRequestPlaintext($plaintext);
            case self::PAYLOAD_TYPE_RESPONSE:
                return self::decodeResponsePlaintext($plaintext);
            case self::PAYLOAD_TYPE_TXT_MSG:
                return self::decodeTextPlaintext($plaintext);
            case self::PAYLOAD_TYPE_PATH:
                return self::decodePathPlaintext($plaintext);
            default:
                return array(
                    'raw_hex' => strtoupper(bin2hex($plaintext)),
                );
        }
    }

    private static function decodeRequestPlaintext($plaintext) {
        $decoded = array(
            'raw_hex' => strtoupper(bin2hex($plaintext)),
        );

        if (strlen($plaintext) >= 4) {
            $decoded['timestamp'] = self::u32le(substr($plaintext, 0, 4));
        }

        if (strlen($plaintext) >= 5) {
            $requestType = ord($plaintext[4]);
            $decoded['request_type'] = $requestType;
            $decoded['request_name'] = self::lookup(self::$requestNames, $requestType, 'unknown');
            $decoded['request_data_hex'] = strtoupper(bin2hex(substr($plaintext, 5)));
        }

        return $decoded;
    }

    private static function decodeResponsePlaintext($plaintext) {
        return array(
            'raw_hex' => strtoupper(bin2hex($plaintext)),
            'text' => self::cleanText($plaintext),
        );
    }

    private static function decodeTextPlaintext($plaintext) {
        $decoded = array(
            'raw_hex' => strtoupper(bin2hex($plaintext)),
        );

        if (strlen($plaintext) < 5) {
            return $decoded;
        }

        $flags = ord($plaintext[4]);
        $txtType = ($flags >> 2) & 0x3F;
        $attempt = $flags & 0x03;
        $messageBytes = substr($plaintext, 5);

        $decoded['timestamp'] = self::u32le(substr($plaintext, 0, 4));
        $decoded['txt_type'] = $txtType;
        $decoded['attempt'] = $attempt;
        $decoded['txt_type_name'] = self::lookup(array(
            0x00 => 'plain',
            0x01 => 'cli',
            0x02 => 'signed_plain',
        ), $txtType, 'unknown');

        if ($txtType === 0x02 && strlen($messageBytes) >= 4) {
            $decoded['sender_pubkey_prefix'] = strtoupper(bin2hex(substr($messageBytes, 0, 4)));
            $messageBytes = substr($messageBytes, 4);
        }

        $decoded['message'] = self::cleanText($messageBytes);
        return $decoded;
    }

    private static function decodePathPlaintext($plaintext) {
        $decoded = array(
            'raw_hex' => strtoupper(bin2hex($plaintext)),
        );

        if ($plaintext === '') {
            return $decoded;
        }

        $pathLength = ord($plaintext[0]);
        $decoded['path_length'] = $pathLength;

        if (strlen($plaintext) >= 1 + $pathLength) {
            $decoded['path'] = self::splitHashes(substr($plaintext, 1, $pathLength), 1);
        }

        if (strlen($plaintext) >= 2 + $pathLength) {
            $extraType = ord($plaintext[1 + $pathLength]);
            $extra = substr($plaintext, 2 + $pathLength);
            $decoded['extra_type'] = $extraType;
            $decoded['extra_type_name'] = self::lookup(self::$payloadNames, $extraType, 'unknown');
            $decoded['extra_hex'] = strtoupper(bin2hex($extra));
        }

        return $decoded;
    }

    private static function decodeAnonRequestPlaintext($plaintext) {
        $decoded = array(
            'raw_hex' => strtoupper(bin2hex($plaintext)),
        );

        if (strlen($plaintext) >= 4) {
            $decoded['timestamp'] = self::u32le(substr($plaintext, 0, 4));
        }

        if (strlen($plaintext) >= 8 && self::looksLikeText(substr($plaintext, 8))) {
            $decoded['sync_timestamp'] = self::u32le(substr($plaintext, 4, 4));
            $decoded['password'] = self::cleanText(substr($plaintext, 8));
            return $decoded;
        }

        if (strlen($plaintext) >= 6) {
            $reqType = ord($plaintext[4]);
            if ($reqType >= 0x01 && $reqType <= 0x03) {
                $replyPathLen = ord($plaintext[5]);
                $decoded['request_type'] = $reqType;
                $decoded['reply_path_length'] = $replyPathLen;
                $decoded['reply_path'] = self::splitHashes(substr($plaintext, 6, $replyPathLen), 1);
                $decoded['request_data_hex'] = strtoupper(bin2hex(substr($plaintext, 6 + $replyPathLen)));
                return $decoded;
            }
        }

        if (strlen($plaintext) > 4) {
            $decoded['password'] = self::cleanText(substr($plaintext, 4));
        }

        return $decoded;
    }

    private static function decodeGroupDataPlaintext($plaintext) {
        $decoded = array(
            'raw_hex' => strtoupper(bin2hex($plaintext)),
        );

        if (strlen($plaintext) >= 3) {
            $decoded['data_type'] = self::u16le(substr($plaintext, 0, 2));
            $decoded['data_len'] = ord($plaintext[2]);
            $decoded['data_hex'] = strtoupper(bin2hex(substr($plaintext, 3)));
        }

        return $decoded;
    }

    private static function decodeTracePayload($payload, array $pathInfo) {
        $decoded = array(
            'raw_hex' => strtoupper(bin2hex($payload)),
            'path_hashes' => $pathInfo['hashes'],
        );

        if (strlen($payload) >= 4) {
            $decoded['trace_tag'] = self::u32le(substr($payload, 0, 4));
            $decoded['trace_tag_hex'] = strtoupper(bin2hex(substr($payload, 0, 4)));
        }

        if ($pathInfo['raw_hex'] !== '') {
            $bytes = hex2bin($pathInfo['raw_hex']);
            $snrValues = array();
            $count = strlen($bytes);
            for ($i = 0; $i < $count; $i++) {
                $snrValues[] = self::i8($bytes[$i]) / 4.0;
            }
            $decoded['snr_values'] = $snrValues;
        }

        return $decoded;
    }

    private static function prepareKeys(array $keys) {
        $prepared = array(
            'channels' => array_fill(0, 256, array()),
            'node_keys' => array_fill(0, 256, array()),
            'public_keys' => array_fill(0, 256, array()),
        );

        $channelCandidates = array();
        if (isset($keys['channel_secrets']) && is_array($keys['channel_secrets'])) {
            $channelCandidates = $keys['channel_secrets'];
        } elseif (isset($keys['channels']) && is_array($keys['channels'])) {
            $channelCandidates = $keys['channels'];
        }

        foreach ($channelCandidates as $secret) {
            $secretBytes = self::normalizeBytes($secret);
            if ($secretBytes === false || $secretBytes === '' || strlen($secretBytes) < 16) {
                continue;
            }

            $secretBytes = substr($secretBytes, 0, 16);
            $secretHash = hash('sha256', $secretBytes, true);
            $hashByte = ord($secretHash[0]);
            $prepared['channels'][$hashByte][] = array(
                'secret' => $secretBytes,
                'secret_hex' => strtoupper(bin2hex($secretBytes)),
            );
        }

        $publicKeyCandidates = array();
        if (isset($keys['public_keys']) && is_array($keys['public_keys'])) {
            $publicKeyCandidates = $keys['public_keys'];
        }

        foreach ($publicKeyCandidates as $publicKey) {
            self::appendPublicKey($prepared['public_keys'], $publicKey);
        }

        if (isset($keys['node_keys']) && is_array($keys['node_keys'])) {
            foreach ($keys['node_keys'] as $nodeKey) {
                $parsed = self::parseNodeKey($nodeKey);
                if ($parsed === false) {
                    continue;
                }

                $prepared['node_keys'][$parsed['hash_byte']][] = $parsed;
                $prepared['public_keys'][$parsed['hash_byte']][] = array(
                    'public_key' => $parsed['public_key'],
                    'public_key_hex' => $parsed['public_key_hex'],
                );
            }
        }

        return $prepared;
    }

    private static function appendPublicKey(array &$bucket, $publicKey) {
        $publicKeyBytes = self::normalizeBytes($publicKey);
        if ($publicKeyBytes === false || strlen($publicKeyBytes) !== 32) {
            return;
        }

        $hashByte = ord($publicKeyBytes[0]);
        $bucket[$hashByte][] = array(
            'public_key' => $publicKeyBytes,
            'public_key_hex' => strtoupper(bin2hex($publicKeyBytes)),
        );
    }

    private static function parseNodeKey($nodeKey) {
        $publicKey = null;
        $privateKey = null;

        if (is_string($nodeKey)) {
            $parts = preg_split('/[: ,]/', $nodeKey, 2);
            if (count($parts) === 2) {
                $publicKey = $parts[0];
                $privateKey = $parts[1];
            }
        } elseif (is_array($nodeKey)) {
            $publicKey = $nodeKey['public_key'] ?? $nodeKey['pubkey'] ?? null;
            $privateKey = $nodeKey['private_key'] ?? $nodeKey['privkey'] ?? null;
        }

        $publicKeyBytes = self::normalizeBytes($publicKey);
        $privateKeyBytes = self::normalizeBytes($privateKey);

        if ($publicKeyBytes === false || $privateKeyBytes === false) {
            return false;
        }

        if (strlen($publicKeyBytes) !== 32) {
            return false;
        }

        if (
            strlen($privateKeyBytes) === 32 &&
            function_exists('sodium_crypto_sign_seed_keypair') &&
            function_exists('sodium_crypto_sign_secretkey')
        ) {
            try {
                $keypair = sodium_crypto_sign_seed_keypair($privateKeyBytes);
                $privateKeyBytes = sodium_crypto_sign_secretkey($keypair);
            } catch (Throwable $e) {
                return false;
            }
        }

        if (strlen($privateKeyBytes) !== 64) {
            return false;
        }

        return array(
            'hash_byte' => ord($publicKeyBytes[0]),
            'public_key' => $publicKeyBytes,
            'public_key_hex' => strtoupper(bin2hex($publicKeyBytes)),
            'private_key' => $privateKeyBytes,
            'private_key_hex' => strtoupper(bin2hex($privateKeyBytes)),
        );
    }

    private static function deriveSharedSecret($privateKey, $publicKey) {
        if (
            !function_exists('sodium_crypto_sign_ed25519_sk_to_curve25519') ||
            !function_exists('sodium_crypto_sign_ed25519_pk_to_curve25519') ||
            !function_exists('sodium_crypto_scalarmult')
        ) {
            return false;
        }

        try {
            $curvePrivateKey = sodium_crypto_sign_ed25519_sk_to_curve25519($privateKey);
            $curvePublicKey = sodium_crypto_sign_ed25519_pk_to_curve25519($publicKey);
            return sodium_crypto_scalarmult($curvePrivateKey, $curvePublicKey);
        } catch (Throwable $e) {
            return false;
        }
    }

    private static function decryptCiphertext($ciphertext, $mac, $keyMaterial) {
        if ($ciphertext === '' || !function_exists('openssl_decrypt')) {
            return false;
        }

        $keyLength = strlen($keyMaterial);
        if ($keyLength !== 16 && $keyLength !== 32) {
            return false;
        }

        $aesKey = substr($keyMaterial, 0, 16);
        $macKeys = array();

        if ($keyLength === 16) {
            $macKeys[] = $keyMaterial;
            $macKeys[] = hash('sha256', $keyMaterial, true);
        } else {
            $macKeys[] = $keyMaterial;
            $macKeys[] = substr($keyMaterial, 16, 16);
            $macKeys[] = hash('sha256', $keyMaterial, true);
        }

        foreach ($macKeys as $macKey) {
            $check = substr(hash_hmac('sha256', $ciphertext, $macKey, true), 0, 2);
            if (!hash_equals($check, $mac)) {
                continue;
            }

            $plaintext = openssl_decrypt(
                $ciphertext,
                'aes-128-ecb',
                $aesKey,
                OPENSSL_RAW_DATA | OPENSSL_ZERO_PADDING
            );

            if ($plaintext === false) {
                continue;
            }

            return rtrim($plaintext, "\0");
        }

        return false;
    }

    private static function splitHashes($bytes, $hashSize) {
        $hashes = array();
        if ($bytes === '' || $hashSize < 1) {
            return $hashes;
        }

        $length = strlen($bytes);
        for ($offset = 0; $offset + $hashSize <= $length; $offset += $hashSize) {
            $hashes[] = strtoupper(bin2hex(substr($bytes, $offset, $hashSize)));
        }

        return $hashes;
    }

    private static function normalizeBytes($value) {
        if (!is_string($value) || $value === '') {
            return false;
        }

        if (preg_match('/^[0-9a-fA-F\s]+$/', $value)) {
            $hex = preg_replace('/\s+/', '', $value);
            if (($hex !== '') && (strlen($hex) % 2 === 0)) {
                $bin = @hex2bin($hex);
                if ($bin !== false) {
                    return $bin;
                }
            }
        }

        return $value;
    }

    private static function cleanText($bytes) {
        $bytes = rtrim($bytes, "\0");
        $bytes = preg_replace('/[[:^print:]\t\r\n]/', '', $bytes);
        return trim($bytes);
    }

    private static function looksLikeText($bytes) {
        if ($bytes === '') {
            return false;
        }

        $text = self::cleanText($bytes);
        return $text !== '';
    }

    private static function u16le($bytes) {
        $unpacked = unpack('v', $bytes);
        return $unpacked[1];
    }

    private static function u32le($bytes) {
        $unpacked = unpack('V', $bytes);
        return $unpacked[1];
    }

    private static function i32le($bytes) {
        $value = self::u32le($bytes);
        if ($value >= 0x80000000) {
            $value -= 0x100000000;
        }
        return $value;
    }

    private static function i8($byte) {
        $value = ord($byte);
        return $value > 127 ? $value - 256 : $value;
    }

    private static function lookup(array $map, $key, $default = null) {
        return array_key_exists($key, $map) ? $map[$key] : $default;
    }
}

?>

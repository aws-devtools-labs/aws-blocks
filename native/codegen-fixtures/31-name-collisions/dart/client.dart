// GENERATED CODE — DO NOT MODIFY BY HAND
// Generator: blocks-codegen
// Source: test v1.0.0
// ignore_for_file: constant_identifier_names

import 'package:blocks_runtime/blocks_runtime.dart';
export 'package:blocks_runtime/blocks_runtime.dart' show BlocksClient, BlocksRpcException, SessionStore, InMemorySessionStore;
export 'package:blocks_runtime/blocks_runtime.dart' show RealtimeChannel, FileDownloadHandle, FileUploadHandle;

// --- Models ---

class CartTags {
  final String label;

  const CartTags({
    required this.label,
  });

  factory CartTags.fromJson(Map<String, dynamic> json) {
    return CartTags(
      label: json['label'] as String,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'label': label,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is CartTags &&
          label == other.label;

  @override
  int get hashCode => label.hashCode;

  @override
  String toString() => 'CartTags(label: $label)';
}


class CartTagsValue {
  final num weight;

  const CartTagsValue({
    required this.weight,
  });

  factory CartTagsValue.fromJson(Map<String, dynamic> json) {
    return CartTagsValue(
      weight: json['weight'] as num,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'weight': weight,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is CartTagsValue &&
          weight == other.weight;

  @override
  int get hashCode => weight.hashCode;

  @override
  String toString() => 'CartTagsValue(weight: $weight)';
}


enum OrderStatus {
  pending,
  shipped
;

  String toJson() => name;
  static OrderStatus fromJson(String json) => values.byName(json);
}


enum TicketStatus {
  open,
  closed
;

  String toJson() => name;
  static TicketStatus fromJson(String json) => values.byName(json);
}


enum TicketKind {
  bug,
  task
;

  String toJson() => name;
  static TicketKind fromJson(String json) => values.byName(json);
}


enum TicketKinds {
  urgent,
  later
;

  String toJson() => name;
  static TicketKinds fromJson(String json) => values.byName(json);
}


sealed class TicketPayload {
  const TicketPayload();
  Map<String, dynamic> toJson();
  static TicketPayload fromJson(Map<String, dynamic> json) {
    switch (json['type'] as String) {
      case 'text': return TextTicketPayload.fromJson(json);
      case 'count': return CountTicketPayload.fromJson(json);
      default: throw ArgumentError('Unknown type: ${json['type']}');
    }
  }
}

class TextTicketPayload extends TicketPayload {
  final String body;

  const TextTicketPayload({
    required this.body,
  });

  factory TextTicketPayload.fromJson(Map<String, dynamic> json) {
    return TextTicketPayload(
      body: json['body'] as String,
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'type': 'text',
      'body': body,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is TextTicketPayload &&
          body == other.body;

  @override
  int get hashCode => body.hashCode;

  @override
  String toString() => 'TextTicketPayload(body: $body)';
}

class CountTicketPayload extends TicketPayload {
  final num total;

  const CountTicketPayload({
    required this.total,
  });

  factory CountTicketPayload.fromJson(Map<String, dynamic> json) {
    return CountTicketPayload(
      total: json['total'] as num,
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'type': 'count',
      'total': total,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is CountTicketPayload &&
          total == other.total;

  @override
  int get hashCode => total.hashCode;

  @override
  String toString() => 'CountTicketPayload(total: $total)';
}



sealed class TicketPayloads {
  const TicketPayloads();
  Map<String, dynamic> toJson();
  static TicketPayloads fromJson(Map<String, dynamic> json) {
    switch (json['format'] as String) {
      case 'plain': return PlainTicketPayloads.fromJson(json);
      case 'rich': return RichTicketPayloads.fromJson(json);
      default: throw ArgumentError('Unknown format: ${json['format']}');
    }
  }
}

class PlainTicketPayloads extends TicketPayloads {
  final String raw;

  const PlainTicketPayloads({
    required this.raw,
  });

  factory PlainTicketPayloads.fromJson(Map<String, dynamic> json) {
    return PlainTicketPayloads(
      raw: json['raw'] as String,
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'format': 'plain',
      'raw': raw,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is PlainTicketPayloads &&
          raw == other.raw;

  @override
  int get hashCode => raw.hashCode;

  @override
  String toString() => 'PlainTicketPayloads(raw: $raw)';
}

class RichTicketPayloads extends TicketPayloads {
  final String html;

  const RichTicketPayloads({
    required this.html,
  });

  factory RichTicketPayloads.fromJson(Map<String, dynamic> json) {
    return RichTicketPayloads(
      html: json['html'] as String,
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'format': 'rich',
      'html': html,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is RichTicketPayloads &&
          html == other.html;

  @override
  int get hashCode => html.hashCode;

  @override
  String toString() => 'RichTicketPayloads(html: $html)';
}



class PutItemsResultItem {
  final num count;

  const PutItemsResultItem({
    required this.count,
  });

  factory PutItemsResultItem.fromJson(Map<String, dynamic> json) {
    return PutItemsResultItem(
      count: json['count'] as num,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'count': count,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is PutItemsResultItem &&
          count == other.count;

  @override
  int get hashCode => count.hashCode;

  @override
  String toString() => 'PutItemsResultItem(count: $count)';
}


class GetFeedsResultFeedMessage {
  final String text;

  const GetFeedsResultFeedMessage({
    required this.text,
  });

  factory GetFeedsResultFeedMessage.fromJson(Map<String, dynamic> json) {
    return GetFeedsResultFeedMessage(
      text: json['text'] as String,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'text': text,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is GetFeedsResultFeedMessage &&
          text == other.text;

  @override
  int get hashCode => text.hashCode;

  @override
  String toString() => 'GetFeedsResultFeedMessage(text: $text)';
}


class PickActResultItems {
  final num qty;

  const PickActResultItems({
    required this.qty,
  });

  factory PickActResultItems.fromJson(Map<String, dynamic> json) {
    return PickActResultItems(
      qty: json['qty'] as num,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'qty': qty,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is PickActResultItems &&
          qty == other.qty;

  @override
  int get hashCode => qty.hashCode;

  @override
  String toString() => 'PickActResultItems(qty: $qty)';
}


// --- API Namespaces ---

class CartItem {
  final String sku;

  const CartItem({
    required this.sku,
  });

  factory CartItem.fromJson(Map<String, dynamic> json) {
    return CartItem(
      sku: json['sku'] as String,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'sku': sku,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is CartItem &&
          sku == other.sku;

  @override
  int get hashCode => sku.hashCode;

  @override
  String toString() => 'CartItem(sku: $sku)';
}


class CartItems {
  final String sku;
  final num qty;

  const CartItems({
    required this.sku,
    required this.qty,
  });

  factory CartItems.fromJson(Map<String, dynamic> json) {
    return CartItems(
      sku: json['sku'] as String,
      qty: json['qty'] as num,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'sku': sku,
      'qty': qty,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is CartItems &&
          sku == other.sku &&
          qty == other.qty;

  @override
  int get hashCode => Object.hash(sku, qty);

  @override
  String toString() => 'CartItems(sku: $sku, qty: $qty)';
}


class Cart {
  final String id;
  final CartItem item;
  final List<CartItems> items;
  final Map<String, CartTags> tags;
  final CartTagsValue tagsValue;

  const Cart({
    required this.id,
    required this.item,
    required this.items,
    required this.tags,
    required this.tagsValue,
  });

  factory Cart.fromJson(Map<String, dynamic> json) {
    return Cart(
      id: json['id'] as String,
      item: CartItem.fromJson(json['item'] as Map<String, dynamic>),
      items: (json['items'] as List<dynamic>).map((e) => CartItems.fromJson(e as Map<String, dynamic>)).toList(),
      tags: (json['tags'] as Map<String, dynamic>).map((k, v) => MapEntry(k, CartTags.fromJson(v as Map<String, dynamic>))),
      tagsValue: CartTagsValue.fromJson(json['tagsValue'] as Map<String, dynamic>),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'id': id,
      'item': item.toJson(),
      'items': items.map((e) => e.toJson()).toList(),
      'tags': tags.map((k, v) => MapEntry(k, v.toJson())),
      'tagsValue': tagsValue.toJson(),
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is Cart &&
          id == other.id &&
          item == other.item &&
          blocksDeepEquals(items, other.items) &&
          blocksDeepEquals(tags, other.tags) &&
          tagsValue == other.tagsValue;

  @override
  int get hashCode => Object.hash(id, item, blocksDeepHash(items), blocksDeepHash(tags), tagsValue);

  @override
  String toString() => 'Cart(id: $id, item: $item, items: $items, tags: $tags, tagsValue: $tagsValue)';
}


enum Kind {
  x,
  y
;

  String toJson() => name;
  static Kind fromJson(String json) => values.byName(json);
}


class Order {
  final OrderStatus status;

  const Order({
    required this.status,
  });

  factory Order.fromJson(Map<String, dynamic> json) {
    return Order(
      status: OrderStatus.fromJson(json['status'] as String),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'status': status.toJson(),
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is Order &&
          status == other.status;

  @override
  int get hashCode => status.hashCode;

  @override
  String toString() => 'Order(status: $status)';
}


class Ticket {
  final TicketStatus status;
  final TicketKind kind;
  final List<TicketKinds> kinds;
  final TicketPayload payload;
  final List<TicketPayloads> payloads;

  const Ticket({
    required this.status,
    required this.kind,
    required this.kinds,
    required this.payload,
    required this.payloads,
  });

  factory Ticket.fromJson(Map<String, dynamic> json) {
    return Ticket(
      status: TicketStatus.fromJson(json['status'] as String),
      kind: TicketKind.fromJson(json['kind'] as String),
      kinds: (json['kinds'] as List<dynamic>).map((e) => TicketKinds.fromJson(e as String)).toList(),
      payload: TicketPayload.fromJson(json['payload'] as Map<String, dynamic>),
      payloads: (json['payloads'] as List<dynamic>).map((e) => TicketPayloads.fromJson(e as Map<String, dynamic>)).toList(),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'status': status.toJson(),
      'kind': kind.toJson(),
      'kinds': kinds.map((e) => e.toJson()).toList(),
      'payload': payload.toJson(),
      'payloads': payloads.map((e) => e.toJson()).toList(),
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is Ticket &&
          status == other.status &&
          kind == other.kind &&
          blocksDeepEquals(kinds, other.kinds) &&
          payload == other.payload &&
          blocksDeepEquals(payloads, other.payloads);

  @override
  int get hashCode => Object.hash(status, kind, blocksDeepHash(kinds), payload, blocksDeepHash(payloads));

  @override
  String toString() => 'Ticket(status: $status, kind: $kind, kinds: $kinds, payload: $payload, payloads: $payloads)';
}


class PutItemsResult {
  final PutItemsResultItem item;
  final List<CartItem> items;

  const PutItemsResult({
    required this.item,
    required this.items,
  });

  factory PutItemsResult.fromJson(Map<String, dynamic> json) {
    return PutItemsResult(
      item: PutItemsResultItem.fromJson(json['item'] as Map<String, dynamic>),
      items: (json['items'] as List<dynamic>).map((e) => CartItem.fromJson(e as Map<String, dynamic>)).toList(),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'item': item.toJson(),
      'items': items.map((e) => e.toJson()).toList(),
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is PutItemsResult &&
          item == other.item &&
          blocksDeepEquals(items, other.items);

  @override
  int get hashCode => Object.hash(item, blocksDeepHash(items));

  @override
  String toString() => 'PutItemsResult(item: $item, items: $items)';
}


class GetFeedsResult {
  final RealtimeChannel<GetFeedsResultFeedMessage> feed;
  final List<RealtimeChannel<PutItemsResultItem>> feeds;

  const GetFeedsResult({
    required this.feed,
    required this.feeds,
  });

  factory GetFeedsResult.fromJson(Map<String, dynamic> json) {
    return GetFeedsResult(
      feed: RealtimeChannel.fromJson(json['feed'] as Map<String, dynamic>, (json) => GetFeedsResultFeedMessage.fromJson(json)),
      feeds: (json['feeds'] as List<dynamic>).map((e) => RealtimeChannel.fromJson(e as Map<String, dynamic>, (json) => PutItemsResultItem.fromJson(json))).toList(),
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'feed': feed.toJson(),
      'feeds': feeds.map((e) => e.toJson()).toList(),
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is GetFeedsResult &&
          feed == other.feed &&
          blocksDeepEquals(feeds, other.feeds);

  @override
  int get hashCode => Object.hash(feed, blocksDeepHash(feeds));

  @override
  String toString() => 'GetFeedsResult(feed: $feed, feeds: $feeds)';
}


sealed class ActResult {
  const ActResult();
  Map<String, dynamic> toJson();
  static ActResult fromJson(Map<String, dynamic> json) {
    switch (json['action'] as String) {
      case 'pick': return PickActResult.fromJson(json);
      case 'skip': return SkipActResult.fromJson(json);
      default: throw ArgumentError('Unknown action: ${json['action']}');
    }
  }
}

class PickActResult extends ActResult {
  final CartItem item;
  final List<PickActResultItems> items;

  const PickActResult({
    required this.item,
    required this.items,
  });

  factory PickActResult.fromJson(Map<String, dynamic> json) {
    return PickActResult(
      item: CartItem.fromJson(json['item'] as Map<String, dynamic>),
      items: (json['items'] as List<dynamic>).map((e) => PickActResultItems.fromJson(e as Map<String, dynamic>)).toList(),
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'action': 'pick',
      'item': item.toJson(),
      'items': items.map((e) => e.toJson()).toList(),
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is PickActResult &&
          item == other.item &&
          blocksDeepEquals(items, other.items);

  @override
  int get hashCode => Object.hash(item, blocksDeepHash(items));

  @override
  String toString() => 'PickActResult(item: $item, items: $items)';
}

class SkipActResult extends ActResult {
  final String reason;

  const SkipActResult({
    required this.reason,
  });

  factory SkipActResult.fromJson(Map<String, dynamic> json) {
    return SkipActResult(
      reason: json['reason'] as String,
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'action': 'skip',
      'reason': reason,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is SkipActResult &&
          reason == other.reason;

  @override
  int get hashCode => reason.hashCode;

  @override
  String toString() => 'SkipActResult(reason: $reason)';
}



class ApiCheckResult {
  final String input;

  const ApiCheckResult({
    required this.input,
  });

  factory ApiCheckResult.fromJson(Map<String, dynamic> json) {
    return ApiCheckResult(
      input: json['input'] as String,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'input': input,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is ApiCheckResult &&
          input == other.input;

  @override
  int get hashCode => input.hashCode;

  @override
  String toString() => 'ApiCheckResult(input: $input)';
}


class CheckResult {
  final bool passed;

  const CheckResult({
    required this.passed,
  });

  factory CheckResult.fromJson(Map<String, dynamic> json) {
    return CheckResult(
      passed: json['passed'] as bool,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'passed': passed,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is CheckResult &&
          passed == other.passed;

  @override
  int get hashCode => passed.hashCode;

  @override
  String toString() => 'CheckResult(passed: $passed)';
}


class ApiApi {
  final BlocksClient _client;
  ApiApi(this._client);

  Future<Cart> getCart() async {
    final result = await _client.call('api.getCart', const <dynamic>[]);
    return Cart.fromJson(result as Map<String, dynamic>);
  }

  Future<Order> getOrder() async {
    final result = await _client.call('api.getOrder', const <dynamic>[]);
    return Order.fromJson(result as Map<String, dynamic>);
  }

  Future<Ticket> getTicket() async {
    final result = await _client.call('api.getTicket', const <dynamic>[]);
    return Ticket.fromJson(result as Map<String, dynamic>);
  }

  Future<Kind> getKind() async {
    final result = await _client.call('api.getKind', const <dynamic>[]);
    return Kind.fromJson(result as String);
  }

  Future<PutItemsResult> putItems({required CartItem item, required List<CartItems> items}) async {
    final params = <dynamic>[
      item.toJson(),
      items.map((e) => e.toJson()).toList(),
    ];
    final result = await _client.call('api.putItems', params);
    return PutItemsResult.fromJson(result as Map<String, dynamic>);
  }

  Future<GetFeedsResult> getFeeds() async {
    final result = await _client.call('api.getFeeds', const <dynamic>[]);
    return GetFeedsResult.fromJson(result as Map<String, dynamic>);
  }

  Future<ActResult> act() async {
    final result = await _client.call('api.act', const <dynamic>[]);
    return ActResult.fromJson(result as Map<String, dynamic>);
  }

  Future<CheckResult> check({required ApiCheckResult result}) async {
    final params = <dynamic>[
      result.toJson(),
    ];
    final $result = await _client.call('api.check', params);
    return CheckResult.fromJson($result as Map<String, dynamic>);
  }
}


// --- Blocks Client ---

class Blocks {
  late final ApiApi api;

  Blocks({required String baseUrl, SessionStore? sessionStore}) {
    final client = BlocksClient(baseUrl: baseUrl, sessionStore: sessionStore);
    api = ApiApi(client);
  }
}


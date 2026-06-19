// GENERATED CODE — DO NOT MODIFY BY HAND
// Generator: blocks-codegen
// Source: test v1.0.0
// ignore_for_file: constant_identifier_names

import 'package:blocks_runtime/blocks_runtime.dart';
export 'package:blocks_runtime/blocks_runtime.dart' show BlocksClient, BlocksRpcException, SessionStore, InMemorySessionStore;

// --- Models ---

class CognitoUser {
  final String userSub;
  final List<String> groups;
  final Map<String, String?> attributes;
  final String userId;
  final String username;

  const CognitoUser({
    required this.userSub,
    required this.groups,
    required this.attributes,
    required this.userId,
    required this.username,
  });

  factory CognitoUser.fromJson(Map<String, dynamic> json) {
    return CognitoUser(
      userSub: json['userSub'] as String,
      groups: (json['groups'] as List<dynamic>).cast<String>(),
      attributes: (json['attributes'] as Map<String, dynamic>).map((k, v) => MapEntry(k, v as String?)),
      userId: json['userId'] as String,
      username: json['username'] as String,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'userSub': userSub,
      'groups': groups,
      'attributes': attributes,
      'userId': userId,
      'username': username,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is CognitoUser &&
          userSub == other.userSub &&
          groups == other.groups &&
          attributes == other.attributes &&
          userId == other.userId &&
          username == other.username;

  @override
  int get hashCode => Object.hash(userSub, groups, attributes, userId, username);

  @override
  String toString() => 'CognitoUser(userSub: $userSub, groups: $groups, attributes: $attributes, userId: $userId, username: $username)';
}


enum CodeDeliveryDetailsDeliveryMedium {
  SMS,
  EMAIL,
  PHONE_NUMBER
;

  String toJson() => name;
  static CodeDeliveryDetailsDeliveryMedium fromJson(String json) => values.byName(json);
}


class CodeDeliveryDetails {
  final String destination;
  final CodeDeliveryDetailsDeliveryMedium deliveryMedium;
  final String attributeName;

  const CodeDeliveryDetails({
    required this.destination,
    required this.deliveryMedium,
    required this.attributeName,
  });

  factory CodeDeliveryDetails.fromJson(Map<String, dynamic> json) {
    return CodeDeliveryDetails(
      destination: json['destination'] as String,
      deliveryMedium: CodeDeliveryDetailsDeliveryMedium.fromJson(json['deliveryMedium'] as String),
      attributeName: json['attributeName'] as String,
    );
  }

  Map<String, dynamic> toJson() {
    return {
      'destination': destination,
      'deliveryMedium': deliveryMedium.toJson(),
      'attributeName': attributeName,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is CodeDeliveryDetails &&
          destination == other.destination &&
          deliveryMedium == other.deliveryMedium &&
          attributeName == other.attributeName;

  @override
  int get hashCode => Object.hash(destination, deliveryMedium, attributeName);

  @override
  String toString() => 'CodeDeliveryDetails(destination: $destination, deliveryMedium: $deliveryMedium, attributeName: $attributeName)';
}


enum CONTINUE_SIGN_IN_WITH_MFA_SELECTIONContinueSignInCognitoConfirmSignInResultNextStepAllowedMFATypes {
  SMS,
  TOTP,
  EMAIL
;

  String toJson() => name;
  static CONTINUE_SIGN_IN_WITH_MFA_SELECTIONContinueSignInCognitoConfirmSignInResultNextStepAllowedMFATypes fromJson(String json) => values.byName(json);
}


enum CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTIONContinueSignInCognitoConfirmSignInResultNextStepAllowedMFATypes {
  TOTP,
  EMAIL
;

  String toJson() => name;
  static CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTIONContinueSignInCognitoConfirmSignInResultNextStepAllowedMFATypes fromJson(String json) => values.byName(json);
}


enum CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTIONContinueSignInCognitoConfirmSignInResultNextStepAvailableChallenges {
  PASSWORD,
  EMAIL_OTP,
  SMS_OTP,
  WEB_AUTHN
;

  String toJson() => name;
  static CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTIONContinueSignInCognitoConfirmSignInResultNextStepAvailableChallenges fromJson(String json) => values.byName(json);
}


sealed class ContinueSignInCognitoConfirmSignInResultNextStep {
  const ContinueSignInCognitoConfirmSignInResultNextStep();
  Map<String, dynamic> toJson();
  static ContinueSignInCognitoConfirmSignInResultNextStep fromJson(Map<String, dynamic> json) {
    switch (json['name'] as String) {
      case 'CONFIRM_SIGN_IN_WITH_SMS_CODE': return CONFIRM_SIGN_IN_WITH_SMS_CODEContinueSignInCognitoConfirmSignInResultNextStep.fromJson(json);
      case 'CONFIRM_SIGN_IN_WITH_TOTP_CODE': return CONFIRM_SIGN_IN_WITH_TOTP_CODEContinueSignInCognitoConfirmSignInResultNextStep.fromJson(json);
      case 'CONFIRM_SIGN_IN_WITH_EMAIL_CODE': return CONFIRM_SIGN_IN_WITH_EMAIL_CODEContinueSignInCognitoConfirmSignInResultNextStep.fromJson(json);
      case 'CONTINUE_SIGN_IN_WITH_MFA_SELECTION': return CONTINUE_SIGN_IN_WITH_MFA_SELECTIONContinueSignInCognitoConfirmSignInResultNextStep.fromJson(json);
      case 'CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION': return CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTIONContinueSignInCognitoConfirmSignInResultNextStep.fromJson(json);
      case 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP': return CONTINUE_SIGN_IN_WITH_TOTP_SETUPContinueSignInCognitoConfirmSignInResultNextStep.fromJson(json);
      case 'CONTINUE_SIGN_IN_WITH_EMAIL_SETUP': return CONTINUE_SIGN_IN_WITH_EMAIL_SETUPContinueSignInCognitoConfirmSignInResultNextStep.fromJson(json);
      case 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED': return CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIREDContinueSignInCognitoConfirmSignInResultNextStep.fromJson(json);
      case 'CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION': return CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTIONContinueSignInCognitoConfirmSignInResultNextStep.fromJson(json);
      case 'CONFIRM_SIGN_IN_WITH_PASSWORD': return CONFIRM_SIGN_IN_WITH_PASSWORDContinueSignInCognitoConfirmSignInResultNextStep.fromJson(json);
      case 'CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_EMAIL_OTP': return CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_EMAIL_OTPContinueSignInCognitoConfirmSignInResultNextStep.fromJson(json);
      case 'CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_SMS_OTP': return CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_SMS_OTPContinueSignInCognitoConfirmSignInResultNextStep.fromJson(json);
      case 'CONFIRM_SIGN_IN_WITH_WEB_AUTHN': return CONFIRM_SIGN_IN_WITH_WEB_AUTHNContinueSignInCognitoConfirmSignInResultNextStep.fromJson(json);
      case 'RESET_PASSWORD': return RESET_PASSWORDContinueSignInCognitoConfirmSignInResultNextStep.fromJson(json);
      case 'CONFIRM_SIGN_UP': return CONFIRM_SIGN_UPContinueSignInCognitoConfirmSignInResultNextStep.fromJson(json);
      default: throw ArgumentError('Unknown name: ${json['name']}');
    }
  }
}

class CONFIRM_SIGN_IN_WITH_SMS_CODEContinueSignInCognitoConfirmSignInResultNextStep extends ContinueSignInCognitoConfirmSignInResultNextStep {
  final String session;
  final CodeDeliveryDetails codeDeliveryDetails;

  const CONFIRM_SIGN_IN_WITH_SMS_CODEContinueSignInCognitoConfirmSignInResultNextStep({
    required this.session,
    required this.codeDeliveryDetails,
  });

  factory CONFIRM_SIGN_IN_WITH_SMS_CODEContinueSignInCognitoConfirmSignInResultNextStep.fromJson(Map<String, dynamic> json) {
    return CONFIRM_SIGN_IN_WITH_SMS_CODEContinueSignInCognitoConfirmSignInResultNextStep(
      session: json['session'] as String,
      codeDeliveryDetails: CodeDeliveryDetails.fromJson(json['codeDeliveryDetails'] as Map<String, dynamic>),
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'name': 'CONFIRM_SIGN_IN_WITH_SMS_CODE',
      'session': session,
      'codeDeliveryDetails': codeDeliveryDetails.toJson(),
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is CONFIRM_SIGN_IN_WITH_SMS_CODEContinueSignInCognitoConfirmSignInResultNextStep &&
          session == other.session &&
          codeDeliveryDetails == other.codeDeliveryDetails;

  @override
  int get hashCode => Object.hash(session, codeDeliveryDetails);

  @override
  String toString() => 'CONFIRM_SIGN_IN_WITH_SMS_CODEContinueSignInCognitoConfirmSignInResultNextStep(session: $session, codeDeliveryDetails: $codeDeliveryDetails)';
}

class CONFIRM_SIGN_IN_WITH_TOTP_CODEContinueSignInCognitoConfirmSignInResultNextStep extends ContinueSignInCognitoConfirmSignInResultNextStep {
  final String session;

  const CONFIRM_SIGN_IN_WITH_TOTP_CODEContinueSignInCognitoConfirmSignInResultNextStep({
    required this.session,
  });

  factory CONFIRM_SIGN_IN_WITH_TOTP_CODEContinueSignInCognitoConfirmSignInResultNextStep.fromJson(Map<String, dynamic> json) {
    return CONFIRM_SIGN_IN_WITH_TOTP_CODEContinueSignInCognitoConfirmSignInResultNextStep(
      session: json['session'] as String,
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'name': 'CONFIRM_SIGN_IN_WITH_TOTP_CODE',
      'session': session,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is CONFIRM_SIGN_IN_WITH_TOTP_CODEContinueSignInCognitoConfirmSignInResultNextStep &&
          session == other.session;

  @override
  int get hashCode => session.hashCode;

  @override
  String toString() => 'CONFIRM_SIGN_IN_WITH_TOTP_CODEContinueSignInCognitoConfirmSignInResultNextStep(session: $session)';
}

class CONFIRM_SIGN_IN_WITH_EMAIL_CODEContinueSignInCognitoConfirmSignInResultNextStep extends ContinueSignInCognitoConfirmSignInResultNextStep {
  final String session;
  final CodeDeliveryDetails codeDeliveryDetails;

  const CONFIRM_SIGN_IN_WITH_EMAIL_CODEContinueSignInCognitoConfirmSignInResultNextStep({
    required this.session,
    required this.codeDeliveryDetails,
  });

  factory CONFIRM_SIGN_IN_WITH_EMAIL_CODEContinueSignInCognitoConfirmSignInResultNextStep.fromJson(Map<String, dynamic> json) {
    return CONFIRM_SIGN_IN_WITH_EMAIL_CODEContinueSignInCognitoConfirmSignInResultNextStep(
      session: json['session'] as String,
      codeDeliveryDetails: CodeDeliveryDetails.fromJson(json['codeDeliveryDetails'] as Map<String, dynamic>),
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'name': 'CONFIRM_SIGN_IN_WITH_EMAIL_CODE',
      'session': session,
      'codeDeliveryDetails': codeDeliveryDetails.toJson(),
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is CONFIRM_SIGN_IN_WITH_EMAIL_CODEContinueSignInCognitoConfirmSignInResultNextStep &&
          session == other.session &&
          codeDeliveryDetails == other.codeDeliveryDetails;

  @override
  int get hashCode => Object.hash(session, codeDeliveryDetails);

  @override
  String toString() => 'CONFIRM_SIGN_IN_WITH_EMAIL_CODEContinueSignInCognitoConfirmSignInResultNextStep(session: $session, codeDeliveryDetails: $codeDeliveryDetails)';
}

class CONTINUE_SIGN_IN_WITH_MFA_SELECTIONContinueSignInCognitoConfirmSignInResultNextStep extends ContinueSignInCognitoConfirmSignInResultNextStep {
  final String session;
  final List<CONTINUE_SIGN_IN_WITH_MFA_SELECTIONContinueSignInCognitoConfirmSignInResultNextStepAllowedMFATypes> allowedMFATypes;

  const CONTINUE_SIGN_IN_WITH_MFA_SELECTIONContinueSignInCognitoConfirmSignInResultNextStep({
    required this.session,
    required this.allowedMFATypes,
  });

  factory CONTINUE_SIGN_IN_WITH_MFA_SELECTIONContinueSignInCognitoConfirmSignInResultNextStep.fromJson(Map<String, dynamic> json) {
    return CONTINUE_SIGN_IN_WITH_MFA_SELECTIONContinueSignInCognitoConfirmSignInResultNextStep(
      session: json['session'] as String,
      allowedMFATypes: (json['allowedMFATypes'] as List<dynamic>).cast<CONTINUE_SIGN_IN_WITH_MFA_SELECTIONContinueSignInCognitoConfirmSignInResultNextStepAllowedMFATypes>(),
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'name': 'CONTINUE_SIGN_IN_WITH_MFA_SELECTION',
      'session': session,
      'allowedMFATypes': allowedMFATypes,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is CONTINUE_SIGN_IN_WITH_MFA_SELECTIONContinueSignInCognitoConfirmSignInResultNextStep &&
          session == other.session &&
          allowedMFATypes == other.allowedMFATypes;

  @override
  int get hashCode => Object.hash(session, allowedMFATypes);

  @override
  String toString() => 'CONTINUE_SIGN_IN_WITH_MFA_SELECTIONContinueSignInCognitoConfirmSignInResultNextStep(session: $session, allowedMFATypes: $allowedMFATypes)';
}

class CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTIONContinueSignInCognitoConfirmSignInResultNextStep extends ContinueSignInCognitoConfirmSignInResultNextStep {
  final String session;
  final List<CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTIONContinueSignInCognitoConfirmSignInResultNextStepAllowedMFATypes> allowedMFATypes;

  const CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTIONContinueSignInCognitoConfirmSignInResultNextStep({
    required this.session,
    required this.allowedMFATypes,
  });

  factory CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTIONContinueSignInCognitoConfirmSignInResultNextStep.fromJson(Map<String, dynamic> json) {
    return CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTIONContinueSignInCognitoConfirmSignInResultNextStep(
      session: json['session'] as String,
      allowedMFATypes: (json['allowedMFATypes'] as List<dynamic>).cast<CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTIONContinueSignInCognitoConfirmSignInResultNextStepAllowedMFATypes>(),
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'name': 'CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION',
      'session': session,
      'allowedMFATypes': allowedMFATypes,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTIONContinueSignInCognitoConfirmSignInResultNextStep &&
          session == other.session &&
          allowedMFATypes == other.allowedMFATypes;

  @override
  int get hashCode => Object.hash(session, allowedMFATypes);

  @override
  String toString() => 'CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTIONContinueSignInCognitoConfirmSignInResultNextStep(session: $session, allowedMFATypes: $allowedMFATypes)';
}

class CONTINUE_SIGN_IN_WITH_TOTP_SETUPContinueSignInCognitoConfirmSignInResultNextStep extends ContinueSignInCognitoConfirmSignInResultNextStep {
  final String session;
  final String sharedSecret;

  const CONTINUE_SIGN_IN_WITH_TOTP_SETUPContinueSignInCognitoConfirmSignInResultNextStep({
    required this.session,
    required this.sharedSecret,
  });

  factory CONTINUE_SIGN_IN_WITH_TOTP_SETUPContinueSignInCognitoConfirmSignInResultNextStep.fromJson(Map<String, dynamic> json) {
    return CONTINUE_SIGN_IN_WITH_TOTP_SETUPContinueSignInCognitoConfirmSignInResultNextStep(
      session: json['session'] as String,
      sharedSecret: json['sharedSecret'] as String,
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'name': 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP',
      'session': session,
      'sharedSecret': sharedSecret,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is CONTINUE_SIGN_IN_WITH_TOTP_SETUPContinueSignInCognitoConfirmSignInResultNextStep &&
          session == other.session &&
          sharedSecret == other.sharedSecret;

  @override
  int get hashCode => Object.hash(session, sharedSecret);

  @override
  String toString() => 'CONTINUE_SIGN_IN_WITH_TOTP_SETUPContinueSignInCognitoConfirmSignInResultNextStep(session: $session, sharedSecret: $sharedSecret)';
}

class CONTINUE_SIGN_IN_WITH_EMAIL_SETUPContinueSignInCognitoConfirmSignInResultNextStep extends ContinueSignInCognitoConfirmSignInResultNextStep {
  final String session;

  const CONTINUE_SIGN_IN_WITH_EMAIL_SETUPContinueSignInCognitoConfirmSignInResultNextStep({
    required this.session,
  });

  factory CONTINUE_SIGN_IN_WITH_EMAIL_SETUPContinueSignInCognitoConfirmSignInResultNextStep.fromJson(Map<String, dynamic> json) {
    return CONTINUE_SIGN_IN_WITH_EMAIL_SETUPContinueSignInCognitoConfirmSignInResultNextStep(
      session: json['session'] as String,
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'name': 'CONTINUE_SIGN_IN_WITH_EMAIL_SETUP',
      'session': session,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is CONTINUE_SIGN_IN_WITH_EMAIL_SETUPContinueSignInCognitoConfirmSignInResultNextStep &&
          session == other.session;

  @override
  int get hashCode => session.hashCode;

  @override
  String toString() => 'CONTINUE_SIGN_IN_WITH_EMAIL_SETUPContinueSignInCognitoConfirmSignInResultNextStep(session: $session)';
}

class CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIREDContinueSignInCognitoConfirmSignInResultNextStep extends ContinueSignInCognitoConfirmSignInResultNextStep {
  final String session;
  final List<String>? requiredAttributes;

  const CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIREDContinueSignInCognitoConfirmSignInResultNextStep({
    required this.session,
    this.requiredAttributes,
  });

  factory CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIREDContinueSignInCognitoConfirmSignInResultNextStep.fromJson(Map<String, dynamic> json) {
    return CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIREDContinueSignInCognitoConfirmSignInResultNextStep(
      session: json['session'] as String,
      requiredAttributes: (json['requiredAttributes'] as List<dynamic>?)?.cast<String>(),
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'name': 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED',
      'session': session,
      if (requiredAttributes != null) 'requiredAttributes': requiredAttributes,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIREDContinueSignInCognitoConfirmSignInResultNextStep &&
          session == other.session &&
          requiredAttributes == other.requiredAttributes;

  @override
  int get hashCode => Object.hash(session, requiredAttributes);

  @override
  String toString() => 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIREDContinueSignInCognitoConfirmSignInResultNextStep(session: $session, requiredAttributes: $requiredAttributes)';
}

class CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTIONContinueSignInCognitoConfirmSignInResultNextStep extends ContinueSignInCognitoConfirmSignInResultNextStep {
  final String session;
  final List<CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTIONContinueSignInCognitoConfirmSignInResultNextStepAvailableChallenges> availableChallenges;

  const CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTIONContinueSignInCognitoConfirmSignInResultNextStep({
    required this.session,
    required this.availableChallenges,
  });

  factory CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTIONContinueSignInCognitoConfirmSignInResultNextStep.fromJson(Map<String, dynamic> json) {
    return CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTIONContinueSignInCognitoConfirmSignInResultNextStep(
      session: json['session'] as String,
      availableChallenges: (json['availableChallenges'] as List<dynamic>).cast<CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTIONContinueSignInCognitoConfirmSignInResultNextStepAvailableChallenges>(),
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'name': 'CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION',
      'session': session,
      'availableChallenges': availableChallenges,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTIONContinueSignInCognitoConfirmSignInResultNextStep &&
          session == other.session &&
          availableChallenges == other.availableChallenges;

  @override
  int get hashCode => Object.hash(session, availableChallenges);

  @override
  String toString() => 'CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTIONContinueSignInCognitoConfirmSignInResultNextStep(session: $session, availableChallenges: $availableChallenges)';
}

class CONFIRM_SIGN_IN_WITH_PASSWORDContinueSignInCognitoConfirmSignInResultNextStep extends ContinueSignInCognitoConfirmSignInResultNextStep {
  final String session;

  const CONFIRM_SIGN_IN_WITH_PASSWORDContinueSignInCognitoConfirmSignInResultNextStep({
    required this.session,
  });

  factory CONFIRM_SIGN_IN_WITH_PASSWORDContinueSignInCognitoConfirmSignInResultNextStep.fromJson(Map<String, dynamic> json) {
    return CONFIRM_SIGN_IN_WITH_PASSWORDContinueSignInCognitoConfirmSignInResultNextStep(
      session: json['session'] as String,
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'name': 'CONFIRM_SIGN_IN_WITH_PASSWORD',
      'session': session,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is CONFIRM_SIGN_IN_WITH_PASSWORDContinueSignInCognitoConfirmSignInResultNextStep &&
          session == other.session;

  @override
  int get hashCode => session.hashCode;

  @override
  String toString() => 'CONFIRM_SIGN_IN_WITH_PASSWORDContinueSignInCognitoConfirmSignInResultNextStep(session: $session)';
}

class CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_EMAIL_OTPContinueSignInCognitoConfirmSignInResultNextStep extends ContinueSignInCognitoConfirmSignInResultNextStep {
  final String session;
  final CodeDeliveryDetails codeDeliveryDetails;

  const CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_EMAIL_OTPContinueSignInCognitoConfirmSignInResultNextStep({
    required this.session,
    required this.codeDeliveryDetails,
  });

  factory CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_EMAIL_OTPContinueSignInCognitoConfirmSignInResultNextStep.fromJson(Map<String, dynamic> json) {
    return CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_EMAIL_OTPContinueSignInCognitoConfirmSignInResultNextStep(
      session: json['session'] as String,
      codeDeliveryDetails: CodeDeliveryDetails.fromJson(json['codeDeliveryDetails'] as Map<String, dynamic>),
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'name': 'CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_EMAIL_OTP',
      'session': session,
      'codeDeliveryDetails': codeDeliveryDetails.toJson(),
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_EMAIL_OTPContinueSignInCognitoConfirmSignInResultNextStep &&
          session == other.session &&
          codeDeliveryDetails == other.codeDeliveryDetails;

  @override
  int get hashCode => Object.hash(session, codeDeliveryDetails);

  @override
  String toString() => 'CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_EMAIL_OTPContinueSignInCognitoConfirmSignInResultNextStep(session: $session, codeDeliveryDetails: $codeDeliveryDetails)';
}

class CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_SMS_OTPContinueSignInCognitoConfirmSignInResultNextStep extends ContinueSignInCognitoConfirmSignInResultNextStep {
  final String session;
  final CodeDeliveryDetails codeDeliveryDetails;

  const CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_SMS_OTPContinueSignInCognitoConfirmSignInResultNextStep({
    required this.session,
    required this.codeDeliveryDetails,
  });

  factory CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_SMS_OTPContinueSignInCognitoConfirmSignInResultNextStep.fromJson(Map<String, dynamic> json) {
    return CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_SMS_OTPContinueSignInCognitoConfirmSignInResultNextStep(
      session: json['session'] as String,
      codeDeliveryDetails: CodeDeliveryDetails.fromJson(json['codeDeliveryDetails'] as Map<String, dynamic>),
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'name': 'CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_SMS_OTP',
      'session': session,
      'codeDeliveryDetails': codeDeliveryDetails.toJson(),
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_SMS_OTPContinueSignInCognitoConfirmSignInResultNextStep &&
          session == other.session &&
          codeDeliveryDetails == other.codeDeliveryDetails;

  @override
  int get hashCode => Object.hash(session, codeDeliveryDetails);

  @override
  String toString() => 'CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_SMS_OTPContinueSignInCognitoConfirmSignInResultNextStep(session: $session, codeDeliveryDetails: $codeDeliveryDetails)';
}

class CONFIRM_SIGN_IN_WITH_WEB_AUTHNContinueSignInCognitoConfirmSignInResultNextStep extends ContinueSignInCognitoConfirmSignInResultNextStep {
  final String session;
  final String credentialRequestOptions;

  const CONFIRM_SIGN_IN_WITH_WEB_AUTHNContinueSignInCognitoConfirmSignInResultNextStep({
    required this.session,
    required this.credentialRequestOptions,
  });

  factory CONFIRM_SIGN_IN_WITH_WEB_AUTHNContinueSignInCognitoConfirmSignInResultNextStep.fromJson(Map<String, dynamic> json) {
    return CONFIRM_SIGN_IN_WITH_WEB_AUTHNContinueSignInCognitoConfirmSignInResultNextStep(
      session: json['session'] as String,
      credentialRequestOptions: json['credentialRequestOptions'] as String,
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'name': 'CONFIRM_SIGN_IN_WITH_WEB_AUTHN',
      'session': session,
      'credentialRequestOptions': credentialRequestOptions,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is CONFIRM_SIGN_IN_WITH_WEB_AUTHNContinueSignInCognitoConfirmSignInResultNextStep &&
          session == other.session &&
          credentialRequestOptions == other.credentialRequestOptions;

  @override
  int get hashCode => Object.hash(session, credentialRequestOptions);

  @override
  String toString() => 'CONFIRM_SIGN_IN_WITH_WEB_AUTHNContinueSignInCognitoConfirmSignInResultNextStep(session: $session, credentialRequestOptions: $credentialRequestOptions)';
}

class RESET_PASSWORDContinueSignInCognitoConfirmSignInResultNextStep extends ContinueSignInCognitoConfirmSignInResultNextStep {

  const RESET_PASSWORDContinueSignInCognitoConfirmSignInResultNextStep();

  factory RESET_PASSWORDContinueSignInCognitoConfirmSignInResultNextStep.fromJson(Map<String, dynamic> json) {
    return RESET_PASSWORDContinueSignInCognitoConfirmSignInResultNextStep(
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'name': 'RESET_PASSWORD',
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is RESET_PASSWORDContinueSignInCognitoConfirmSignInResultNextStep;

  @override
  int get hashCode => runtimeType.hashCode;

  @override
  String toString() => 'RESET_PASSWORDContinueSignInCognitoConfirmSignInResultNextStep()';
}

class CONFIRM_SIGN_UPContinueSignInCognitoConfirmSignInResultNextStep extends ContinueSignInCognitoConfirmSignInResultNextStep {
  final CodeDeliveryDetails? codeDeliveryDetails;

  const CONFIRM_SIGN_UPContinueSignInCognitoConfirmSignInResultNextStep({
    this.codeDeliveryDetails,
  });

  factory CONFIRM_SIGN_UPContinueSignInCognitoConfirmSignInResultNextStep.fromJson(Map<String, dynamic> json) {
    return CONFIRM_SIGN_UPContinueSignInCognitoConfirmSignInResultNextStep(
      codeDeliveryDetails: json['codeDeliveryDetails'] != null ? CodeDeliveryDetails.fromJson(json['codeDeliveryDetails'] as Map<String, dynamic>) : null,
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'name': 'CONFIRM_SIGN_UP',
      if (codeDeliveryDetails != null) 'codeDeliveryDetails': codeDeliveryDetails?.toJson(),
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is CONFIRM_SIGN_UPContinueSignInCognitoConfirmSignInResultNextStep &&
          codeDeliveryDetails == other.codeDeliveryDetails;

  @override
  int get hashCode => codeDeliveryDetails.hashCode;

  @override
  String toString() => 'CONFIRM_SIGN_UPContinueSignInCognitoConfirmSignInResultNextStep(codeDeliveryDetails: $codeDeliveryDetails)';
}



enum CONTINUE_SIGN_IN_WITH_MFA_SELECTIONContinueSignInCognitoSignInResultNextStepAllowedMFATypes {
  SMS,
  TOTP,
  EMAIL
;

  String toJson() => name;
  static CONTINUE_SIGN_IN_WITH_MFA_SELECTIONContinueSignInCognitoSignInResultNextStepAllowedMFATypes fromJson(String json) => values.byName(json);
}


enum CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTIONContinueSignInCognitoSignInResultNextStepAllowedMFATypes {
  TOTP,
  EMAIL
;

  String toJson() => name;
  static CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTIONContinueSignInCognitoSignInResultNextStepAllowedMFATypes fromJson(String json) => values.byName(json);
}


enum CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTIONContinueSignInCognitoSignInResultNextStepAvailableChallenges {
  PASSWORD,
  EMAIL_OTP,
  SMS_OTP,
  WEB_AUTHN
;

  String toJson() => name;
  static CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTIONContinueSignInCognitoSignInResultNextStepAvailableChallenges fromJson(String json) => values.byName(json);
}


sealed class ContinueSignInCognitoSignInResultNextStep {
  const ContinueSignInCognitoSignInResultNextStep();
  Map<String, dynamic> toJson();
  static ContinueSignInCognitoSignInResultNextStep fromJson(Map<String, dynamic> json) {
    switch (json['name'] as String) {
      case 'CONFIRM_SIGN_IN_WITH_SMS_CODE': return CONFIRM_SIGN_IN_WITH_SMS_CODEContinueSignInCognitoSignInResultNextStep.fromJson(json);
      case 'CONFIRM_SIGN_IN_WITH_TOTP_CODE': return CONFIRM_SIGN_IN_WITH_TOTP_CODEContinueSignInCognitoSignInResultNextStep.fromJson(json);
      case 'CONFIRM_SIGN_IN_WITH_EMAIL_CODE': return CONFIRM_SIGN_IN_WITH_EMAIL_CODEContinueSignInCognitoSignInResultNextStep.fromJson(json);
      case 'CONTINUE_SIGN_IN_WITH_MFA_SELECTION': return CONTINUE_SIGN_IN_WITH_MFA_SELECTIONContinueSignInCognitoSignInResultNextStep.fromJson(json);
      case 'CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION': return CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTIONContinueSignInCognitoSignInResultNextStep.fromJson(json);
      case 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP': return CONTINUE_SIGN_IN_WITH_TOTP_SETUPContinueSignInCognitoSignInResultNextStep.fromJson(json);
      case 'CONTINUE_SIGN_IN_WITH_EMAIL_SETUP': return CONTINUE_SIGN_IN_WITH_EMAIL_SETUPContinueSignInCognitoSignInResultNextStep.fromJson(json);
      case 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED': return CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIREDContinueSignInCognitoSignInResultNextStep.fromJson(json);
      case 'CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION': return CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTIONContinueSignInCognitoSignInResultNextStep.fromJson(json);
      case 'CONFIRM_SIGN_IN_WITH_PASSWORD': return CONFIRM_SIGN_IN_WITH_PASSWORDContinueSignInCognitoSignInResultNextStep.fromJson(json);
      case 'CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_EMAIL_OTP': return CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_EMAIL_OTPContinueSignInCognitoSignInResultNextStep.fromJson(json);
      case 'CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_SMS_OTP': return CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_SMS_OTPContinueSignInCognitoSignInResultNextStep.fromJson(json);
      case 'CONFIRM_SIGN_IN_WITH_WEB_AUTHN': return CONFIRM_SIGN_IN_WITH_WEB_AUTHNContinueSignInCognitoSignInResultNextStep.fromJson(json);
      case 'RESET_PASSWORD': return RESET_PASSWORDContinueSignInCognitoSignInResultNextStep.fromJson(json);
      case 'CONFIRM_SIGN_UP': return CONFIRM_SIGN_UPContinueSignInCognitoSignInResultNextStep.fromJson(json);
      default: throw ArgumentError('Unknown name: ${json['name']}');
    }
  }
}

class CONFIRM_SIGN_IN_WITH_SMS_CODEContinueSignInCognitoSignInResultNextStep extends ContinueSignInCognitoSignInResultNextStep {
  final String session;
  final CodeDeliveryDetails codeDeliveryDetails;

  const CONFIRM_SIGN_IN_WITH_SMS_CODEContinueSignInCognitoSignInResultNextStep({
    required this.session,
    required this.codeDeliveryDetails,
  });

  factory CONFIRM_SIGN_IN_WITH_SMS_CODEContinueSignInCognitoSignInResultNextStep.fromJson(Map<String, dynamic> json) {
    return CONFIRM_SIGN_IN_WITH_SMS_CODEContinueSignInCognitoSignInResultNextStep(
      session: json['session'] as String,
      codeDeliveryDetails: CodeDeliveryDetails.fromJson(json['codeDeliveryDetails'] as Map<String, dynamic>),
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'name': 'CONFIRM_SIGN_IN_WITH_SMS_CODE',
      'session': session,
      'codeDeliveryDetails': codeDeliveryDetails.toJson(),
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is CONFIRM_SIGN_IN_WITH_SMS_CODEContinueSignInCognitoSignInResultNextStep &&
          session == other.session &&
          codeDeliveryDetails == other.codeDeliveryDetails;

  @override
  int get hashCode => Object.hash(session, codeDeliveryDetails);

  @override
  String toString() => 'CONFIRM_SIGN_IN_WITH_SMS_CODEContinueSignInCognitoSignInResultNextStep(session: $session, codeDeliveryDetails: $codeDeliveryDetails)';
}

class CONFIRM_SIGN_IN_WITH_TOTP_CODEContinueSignInCognitoSignInResultNextStep extends ContinueSignInCognitoSignInResultNextStep {
  final String session;

  const CONFIRM_SIGN_IN_WITH_TOTP_CODEContinueSignInCognitoSignInResultNextStep({
    required this.session,
  });

  factory CONFIRM_SIGN_IN_WITH_TOTP_CODEContinueSignInCognitoSignInResultNextStep.fromJson(Map<String, dynamic> json) {
    return CONFIRM_SIGN_IN_WITH_TOTP_CODEContinueSignInCognitoSignInResultNextStep(
      session: json['session'] as String,
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'name': 'CONFIRM_SIGN_IN_WITH_TOTP_CODE',
      'session': session,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is CONFIRM_SIGN_IN_WITH_TOTP_CODEContinueSignInCognitoSignInResultNextStep &&
          session == other.session;

  @override
  int get hashCode => session.hashCode;

  @override
  String toString() => 'CONFIRM_SIGN_IN_WITH_TOTP_CODEContinueSignInCognitoSignInResultNextStep(session: $session)';
}

class CONFIRM_SIGN_IN_WITH_EMAIL_CODEContinueSignInCognitoSignInResultNextStep extends ContinueSignInCognitoSignInResultNextStep {
  final String session;
  final CodeDeliveryDetails codeDeliveryDetails;

  const CONFIRM_SIGN_IN_WITH_EMAIL_CODEContinueSignInCognitoSignInResultNextStep({
    required this.session,
    required this.codeDeliveryDetails,
  });

  factory CONFIRM_SIGN_IN_WITH_EMAIL_CODEContinueSignInCognitoSignInResultNextStep.fromJson(Map<String, dynamic> json) {
    return CONFIRM_SIGN_IN_WITH_EMAIL_CODEContinueSignInCognitoSignInResultNextStep(
      session: json['session'] as String,
      codeDeliveryDetails: CodeDeliveryDetails.fromJson(json['codeDeliveryDetails'] as Map<String, dynamic>),
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'name': 'CONFIRM_SIGN_IN_WITH_EMAIL_CODE',
      'session': session,
      'codeDeliveryDetails': codeDeliveryDetails.toJson(),
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is CONFIRM_SIGN_IN_WITH_EMAIL_CODEContinueSignInCognitoSignInResultNextStep &&
          session == other.session &&
          codeDeliveryDetails == other.codeDeliveryDetails;

  @override
  int get hashCode => Object.hash(session, codeDeliveryDetails);

  @override
  String toString() => 'CONFIRM_SIGN_IN_WITH_EMAIL_CODEContinueSignInCognitoSignInResultNextStep(session: $session, codeDeliveryDetails: $codeDeliveryDetails)';
}

class CONTINUE_SIGN_IN_WITH_MFA_SELECTIONContinueSignInCognitoSignInResultNextStep extends ContinueSignInCognitoSignInResultNextStep {
  final String session;
  final List<CONTINUE_SIGN_IN_WITH_MFA_SELECTIONContinueSignInCognitoSignInResultNextStepAllowedMFATypes> allowedMFATypes;

  const CONTINUE_SIGN_IN_WITH_MFA_SELECTIONContinueSignInCognitoSignInResultNextStep({
    required this.session,
    required this.allowedMFATypes,
  });

  factory CONTINUE_SIGN_IN_WITH_MFA_SELECTIONContinueSignInCognitoSignInResultNextStep.fromJson(Map<String, dynamic> json) {
    return CONTINUE_SIGN_IN_WITH_MFA_SELECTIONContinueSignInCognitoSignInResultNextStep(
      session: json['session'] as String,
      allowedMFATypes: (json['allowedMFATypes'] as List<dynamic>).cast<CONTINUE_SIGN_IN_WITH_MFA_SELECTIONContinueSignInCognitoSignInResultNextStepAllowedMFATypes>(),
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'name': 'CONTINUE_SIGN_IN_WITH_MFA_SELECTION',
      'session': session,
      'allowedMFATypes': allowedMFATypes,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is CONTINUE_SIGN_IN_WITH_MFA_SELECTIONContinueSignInCognitoSignInResultNextStep &&
          session == other.session &&
          allowedMFATypes == other.allowedMFATypes;

  @override
  int get hashCode => Object.hash(session, allowedMFATypes);

  @override
  String toString() => 'CONTINUE_SIGN_IN_WITH_MFA_SELECTIONContinueSignInCognitoSignInResultNextStep(session: $session, allowedMFATypes: $allowedMFATypes)';
}

class CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTIONContinueSignInCognitoSignInResultNextStep extends ContinueSignInCognitoSignInResultNextStep {
  final String session;
  final List<CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTIONContinueSignInCognitoSignInResultNextStepAllowedMFATypes> allowedMFATypes;

  const CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTIONContinueSignInCognitoSignInResultNextStep({
    required this.session,
    required this.allowedMFATypes,
  });

  factory CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTIONContinueSignInCognitoSignInResultNextStep.fromJson(Map<String, dynamic> json) {
    return CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTIONContinueSignInCognitoSignInResultNextStep(
      session: json['session'] as String,
      allowedMFATypes: (json['allowedMFATypes'] as List<dynamic>).cast<CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTIONContinueSignInCognitoSignInResultNextStepAllowedMFATypes>(),
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'name': 'CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTION',
      'session': session,
      'allowedMFATypes': allowedMFATypes,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTIONContinueSignInCognitoSignInResultNextStep &&
          session == other.session &&
          allowedMFATypes == other.allowedMFATypes;

  @override
  int get hashCode => Object.hash(session, allowedMFATypes);

  @override
  String toString() => 'CONTINUE_SIGN_IN_WITH_MFA_SETUP_SELECTIONContinueSignInCognitoSignInResultNextStep(session: $session, allowedMFATypes: $allowedMFATypes)';
}

class CONTINUE_SIGN_IN_WITH_TOTP_SETUPContinueSignInCognitoSignInResultNextStep extends ContinueSignInCognitoSignInResultNextStep {
  final String session;
  final String sharedSecret;

  const CONTINUE_SIGN_IN_WITH_TOTP_SETUPContinueSignInCognitoSignInResultNextStep({
    required this.session,
    required this.sharedSecret,
  });

  factory CONTINUE_SIGN_IN_WITH_TOTP_SETUPContinueSignInCognitoSignInResultNextStep.fromJson(Map<String, dynamic> json) {
    return CONTINUE_SIGN_IN_WITH_TOTP_SETUPContinueSignInCognitoSignInResultNextStep(
      session: json['session'] as String,
      sharedSecret: json['sharedSecret'] as String,
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'name': 'CONTINUE_SIGN_IN_WITH_TOTP_SETUP',
      'session': session,
      'sharedSecret': sharedSecret,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is CONTINUE_SIGN_IN_WITH_TOTP_SETUPContinueSignInCognitoSignInResultNextStep &&
          session == other.session &&
          sharedSecret == other.sharedSecret;

  @override
  int get hashCode => Object.hash(session, sharedSecret);

  @override
  String toString() => 'CONTINUE_SIGN_IN_WITH_TOTP_SETUPContinueSignInCognitoSignInResultNextStep(session: $session, sharedSecret: $sharedSecret)';
}

class CONTINUE_SIGN_IN_WITH_EMAIL_SETUPContinueSignInCognitoSignInResultNextStep extends ContinueSignInCognitoSignInResultNextStep {
  final String session;

  const CONTINUE_SIGN_IN_WITH_EMAIL_SETUPContinueSignInCognitoSignInResultNextStep({
    required this.session,
  });

  factory CONTINUE_SIGN_IN_WITH_EMAIL_SETUPContinueSignInCognitoSignInResultNextStep.fromJson(Map<String, dynamic> json) {
    return CONTINUE_SIGN_IN_WITH_EMAIL_SETUPContinueSignInCognitoSignInResultNextStep(
      session: json['session'] as String,
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'name': 'CONTINUE_SIGN_IN_WITH_EMAIL_SETUP',
      'session': session,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is CONTINUE_SIGN_IN_WITH_EMAIL_SETUPContinueSignInCognitoSignInResultNextStep &&
          session == other.session;

  @override
  int get hashCode => session.hashCode;

  @override
  String toString() => 'CONTINUE_SIGN_IN_WITH_EMAIL_SETUPContinueSignInCognitoSignInResultNextStep(session: $session)';
}

class CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIREDContinueSignInCognitoSignInResultNextStep extends ContinueSignInCognitoSignInResultNextStep {
  final String session;
  final List<String>? requiredAttributes;

  const CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIREDContinueSignInCognitoSignInResultNextStep({
    required this.session,
    this.requiredAttributes,
  });

  factory CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIREDContinueSignInCognitoSignInResultNextStep.fromJson(Map<String, dynamic> json) {
    return CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIREDContinueSignInCognitoSignInResultNextStep(
      session: json['session'] as String,
      requiredAttributes: (json['requiredAttributes'] as List<dynamic>?)?.cast<String>(),
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'name': 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIRED',
      'session': session,
      if (requiredAttributes != null) 'requiredAttributes': requiredAttributes,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIREDContinueSignInCognitoSignInResultNextStep &&
          session == other.session &&
          requiredAttributes == other.requiredAttributes;

  @override
  int get hashCode => Object.hash(session, requiredAttributes);

  @override
  String toString() => 'CONFIRM_SIGN_IN_WITH_NEW_PASSWORD_REQUIREDContinueSignInCognitoSignInResultNextStep(session: $session, requiredAttributes: $requiredAttributes)';
}

class CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTIONContinueSignInCognitoSignInResultNextStep extends ContinueSignInCognitoSignInResultNextStep {
  final String session;
  final List<CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTIONContinueSignInCognitoSignInResultNextStepAvailableChallenges> availableChallenges;

  const CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTIONContinueSignInCognitoSignInResultNextStep({
    required this.session,
    required this.availableChallenges,
  });

  factory CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTIONContinueSignInCognitoSignInResultNextStep.fromJson(Map<String, dynamic> json) {
    return CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTIONContinueSignInCognitoSignInResultNextStep(
      session: json['session'] as String,
      availableChallenges: (json['availableChallenges'] as List<dynamic>).cast<CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTIONContinueSignInCognitoSignInResultNextStepAvailableChallenges>(),
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'name': 'CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTION',
      'session': session,
      'availableChallenges': availableChallenges,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTIONContinueSignInCognitoSignInResultNextStep &&
          session == other.session &&
          availableChallenges == other.availableChallenges;

  @override
  int get hashCode => Object.hash(session, availableChallenges);

  @override
  String toString() => 'CONTINUE_SIGN_IN_WITH_FIRST_FACTOR_SELECTIONContinueSignInCognitoSignInResultNextStep(session: $session, availableChallenges: $availableChallenges)';
}

class CONFIRM_SIGN_IN_WITH_PASSWORDContinueSignInCognitoSignInResultNextStep extends ContinueSignInCognitoSignInResultNextStep {
  final String session;

  const CONFIRM_SIGN_IN_WITH_PASSWORDContinueSignInCognitoSignInResultNextStep({
    required this.session,
  });

  factory CONFIRM_SIGN_IN_WITH_PASSWORDContinueSignInCognitoSignInResultNextStep.fromJson(Map<String, dynamic> json) {
    return CONFIRM_SIGN_IN_WITH_PASSWORDContinueSignInCognitoSignInResultNextStep(
      session: json['session'] as String,
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'name': 'CONFIRM_SIGN_IN_WITH_PASSWORD',
      'session': session,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is CONFIRM_SIGN_IN_WITH_PASSWORDContinueSignInCognitoSignInResultNextStep &&
          session == other.session;

  @override
  int get hashCode => session.hashCode;

  @override
  String toString() => 'CONFIRM_SIGN_IN_WITH_PASSWORDContinueSignInCognitoSignInResultNextStep(session: $session)';
}

class CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_EMAIL_OTPContinueSignInCognitoSignInResultNextStep extends ContinueSignInCognitoSignInResultNextStep {
  final String session;
  final CodeDeliveryDetails codeDeliveryDetails;

  const CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_EMAIL_OTPContinueSignInCognitoSignInResultNextStep({
    required this.session,
    required this.codeDeliveryDetails,
  });

  factory CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_EMAIL_OTPContinueSignInCognitoSignInResultNextStep.fromJson(Map<String, dynamic> json) {
    return CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_EMAIL_OTPContinueSignInCognitoSignInResultNextStep(
      session: json['session'] as String,
      codeDeliveryDetails: CodeDeliveryDetails.fromJson(json['codeDeliveryDetails'] as Map<String, dynamic>),
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'name': 'CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_EMAIL_OTP',
      'session': session,
      'codeDeliveryDetails': codeDeliveryDetails.toJson(),
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_EMAIL_OTPContinueSignInCognitoSignInResultNextStep &&
          session == other.session &&
          codeDeliveryDetails == other.codeDeliveryDetails;

  @override
  int get hashCode => Object.hash(session, codeDeliveryDetails);

  @override
  String toString() => 'CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_EMAIL_OTPContinueSignInCognitoSignInResultNextStep(session: $session, codeDeliveryDetails: $codeDeliveryDetails)';
}

class CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_SMS_OTPContinueSignInCognitoSignInResultNextStep extends ContinueSignInCognitoSignInResultNextStep {
  final String session;
  final CodeDeliveryDetails codeDeliveryDetails;

  const CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_SMS_OTPContinueSignInCognitoSignInResultNextStep({
    required this.session,
    required this.codeDeliveryDetails,
  });

  factory CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_SMS_OTPContinueSignInCognitoSignInResultNextStep.fromJson(Map<String, dynamic> json) {
    return CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_SMS_OTPContinueSignInCognitoSignInResultNextStep(
      session: json['session'] as String,
      codeDeliveryDetails: CodeDeliveryDetails.fromJson(json['codeDeliveryDetails'] as Map<String, dynamic>),
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'name': 'CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_SMS_OTP',
      'session': session,
      'codeDeliveryDetails': codeDeliveryDetails.toJson(),
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_SMS_OTPContinueSignInCognitoSignInResultNextStep &&
          session == other.session &&
          codeDeliveryDetails == other.codeDeliveryDetails;

  @override
  int get hashCode => Object.hash(session, codeDeliveryDetails);

  @override
  String toString() => 'CONFIRM_SIGN_IN_WITH_FIRST_FACTOR_SMS_OTPContinueSignInCognitoSignInResultNextStep(session: $session, codeDeliveryDetails: $codeDeliveryDetails)';
}

class CONFIRM_SIGN_IN_WITH_WEB_AUTHNContinueSignInCognitoSignInResultNextStep extends ContinueSignInCognitoSignInResultNextStep {
  final String session;
  final String credentialRequestOptions;

  const CONFIRM_SIGN_IN_WITH_WEB_AUTHNContinueSignInCognitoSignInResultNextStep({
    required this.session,
    required this.credentialRequestOptions,
  });

  factory CONFIRM_SIGN_IN_WITH_WEB_AUTHNContinueSignInCognitoSignInResultNextStep.fromJson(Map<String, dynamic> json) {
    return CONFIRM_SIGN_IN_WITH_WEB_AUTHNContinueSignInCognitoSignInResultNextStep(
      session: json['session'] as String,
      credentialRequestOptions: json['credentialRequestOptions'] as String,
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'name': 'CONFIRM_SIGN_IN_WITH_WEB_AUTHN',
      'session': session,
      'credentialRequestOptions': credentialRequestOptions,
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is CONFIRM_SIGN_IN_WITH_WEB_AUTHNContinueSignInCognitoSignInResultNextStep &&
          session == other.session &&
          credentialRequestOptions == other.credentialRequestOptions;

  @override
  int get hashCode => Object.hash(session, credentialRequestOptions);

  @override
  String toString() => 'CONFIRM_SIGN_IN_WITH_WEB_AUTHNContinueSignInCognitoSignInResultNextStep(session: $session, credentialRequestOptions: $credentialRequestOptions)';
}

class RESET_PASSWORDContinueSignInCognitoSignInResultNextStep extends ContinueSignInCognitoSignInResultNextStep {

  const RESET_PASSWORDContinueSignInCognitoSignInResultNextStep();

  factory RESET_PASSWORDContinueSignInCognitoSignInResultNextStep.fromJson(Map<String, dynamic> json) {
    return RESET_PASSWORDContinueSignInCognitoSignInResultNextStep(
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'name': 'RESET_PASSWORD',
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is RESET_PASSWORDContinueSignInCognitoSignInResultNextStep;

  @override
  int get hashCode => runtimeType.hashCode;

  @override
  String toString() => 'RESET_PASSWORDContinueSignInCognitoSignInResultNextStep()';
}

class CONFIRM_SIGN_UPContinueSignInCognitoSignInResultNextStep extends ContinueSignInCognitoSignInResultNextStep {
  final CodeDeliveryDetails? codeDeliveryDetails;

  const CONFIRM_SIGN_UPContinueSignInCognitoSignInResultNextStep({
    this.codeDeliveryDetails,
  });

  factory CONFIRM_SIGN_UPContinueSignInCognitoSignInResultNextStep.fromJson(Map<String, dynamic> json) {
    return CONFIRM_SIGN_UPContinueSignInCognitoSignInResultNextStep(
      codeDeliveryDetails: json['codeDeliveryDetails'] != null ? CodeDeliveryDetails.fromJson(json['codeDeliveryDetails'] as Map<String, dynamic>) : null,
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'name': 'CONFIRM_SIGN_UP',
      if (codeDeliveryDetails != null) 'codeDeliveryDetails': codeDeliveryDetails?.toJson(),
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is CONFIRM_SIGN_UPContinueSignInCognitoSignInResultNextStep &&
          codeDeliveryDetails == other.codeDeliveryDetails;

  @override
  int get hashCode => codeDeliveryDetails.hashCode;

  @override
  String toString() => 'CONFIRM_SIGN_UPContinueSignInCognitoSignInResultNextStep(codeDeliveryDetails: $codeDeliveryDetails)';
}



// --- API Namespaces ---

sealed class CognitoConfirmSignInResult {
  const CognitoConfirmSignInResult();
  Map<String, dynamic> toJson();
  static CognitoConfirmSignInResult fromJson(Map<String, dynamic> json) {
    switch (json['status'] as String) {
      case 'continueSignIn': return ContinueSignInCognitoConfirmSignInResult.fromJson(json);
      case 'signedIn': return SignedInCognitoConfirmSignInResult.fromJson(json);
      default: throw ArgumentError('Unknown status: ${json['status']}');
    }
  }
}

class ContinueSignInCognitoConfirmSignInResult extends CognitoConfirmSignInResult {
  final ContinueSignInCognitoConfirmSignInResultNextStep nextStep;

  const ContinueSignInCognitoConfirmSignInResult({
    required this.nextStep,
  });

  factory ContinueSignInCognitoConfirmSignInResult.fromJson(Map<String, dynamic> json) {
    return ContinueSignInCognitoConfirmSignInResult(
      nextStep: ContinueSignInCognitoConfirmSignInResultNextStep.fromJson(json['nextStep'] as Map<String, dynamic>),
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'status': 'continueSignIn',
      'nextStep': nextStep.toJson(),
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is ContinueSignInCognitoConfirmSignInResult &&
          nextStep == other.nextStep;

  @override
  int get hashCode => nextStep.hashCode;

  @override
  String toString() => 'ContinueSignInCognitoConfirmSignInResult(nextStep: $nextStep)';
}

class SignedInCognitoConfirmSignInResult extends CognitoConfirmSignInResult {
  final CognitoUser user;

  const SignedInCognitoConfirmSignInResult({
    required this.user,
  });

  factory SignedInCognitoConfirmSignInResult.fromJson(Map<String, dynamic> json) {
    return SignedInCognitoConfirmSignInResult(
      user: CognitoUser.fromJson(json['user'] as Map<String, dynamic>),
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'status': 'signedIn',
      'user': user.toJson(),
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is SignedInCognitoConfirmSignInResult &&
          user == other.user;

  @override
  int get hashCode => user.hashCode;

  @override
  String toString() => 'SignedInCognitoConfirmSignInResult(user: $user)';
}



sealed class CognitoSignInResult {
  const CognitoSignInResult();
  Map<String, dynamic> toJson();
  static CognitoSignInResult fromJson(Map<String, dynamic> json) {
    switch (json['status'] as String) {
      case 'continueSignIn': return ContinueSignInCognitoSignInResult.fromJson(json);
      case 'signedIn': return SignedInCognitoSignInResult.fromJson(json);
      default: throw ArgumentError('Unknown status: ${json['status']}');
    }
  }
}

class ContinueSignInCognitoSignInResult extends CognitoSignInResult {
  final ContinueSignInCognitoSignInResultNextStep nextStep;

  const ContinueSignInCognitoSignInResult({
    required this.nextStep,
  });

  factory ContinueSignInCognitoSignInResult.fromJson(Map<String, dynamic> json) {
    return ContinueSignInCognitoSignInResult(
      nextStep: ContinueSignInCognitoSignInResultNextStep.fromJson(json['nextStep'] as Map<String, dynamic>),
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'status': 'continueSignIn',
      'nextStep': nextStep.toJson(),
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is ContinueSignInCognitoSignInResult &&
          nextStep == other.nextStep;

  @override
  int get hashCode => nextStep.hashCode;

  @override
  String toString() => 'ContinueSignInCognitoSignInResult(nextStep: $nextStep)';
}

class SignedInCognitoSignInResult extends CognitoSignInResult {
  final CognitoUser user;

  const SignedInCognitoSignInResult({
    required this.user,
  });

  factory SignedInCognitoSignInResult.fromJson(Map<String, dynamic> json) {
    return SignedInCognitoSignInResult(
      user: CognitoUser.fromJson(json['user'] as Map<String, dynamic>),
    );
  }

  @override
  Map<String, dynamic> toJson() {
    return {
      'status': 'signedIn',
      'user': user.toJson(),
    };
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is SignedInCognitoSignInResult &&
          user == other.user;

  @override
  int get hashCode => user.hashCode;

  @override
  String toString() => 'SignedInCognitoSignInResult(user: $user)';
}



class ApiApi {
  final BlocksClient _client;
  ApiApi(this._client);

  Future<CognitoConfirmSignInResult> cognitoConfirmSignIn({required String session, required String challengeResponse}) async {
    final params = <String, dynamic>{
      'session': session,
      'challengeResponse': challengeResponse,
    };
    final result = await _client.call('api.cognitoConfirmSignIn', params);
    return CognitoConfirmSignInResult.fromJson(result as Map<String, dynamic>);
  }

  Future<CognitoSignInResult> cognitoSignIn({required String username, required String password}) async {
    final params = <String, dynamic>{
      'username': username,
      'password': password,
    };
    final result = await _client.call('api.cognitoSignIn', params);
    return CognitoSignInResult.fromJson(result as Map<String, dynamic>);
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


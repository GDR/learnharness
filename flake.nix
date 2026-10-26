{
  description = "LearnHarness: An agent harness for learning: adaptive teaching, practice, and a persistent knowledge graph";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      supportedSystems = [ "aarch64-darwin" "x86_64-linux" ];
      forAllSystems = nixpkgs.lib.genAttrs supportedSystems;
      pkgsFor = nixpkgs.legacyPackages;
    in {
      packages = forAllSystems (system:
        let
          pkgs = pkgsFor.${system};
          pkgJson = builtins.fromJSON (builtins.readFile ./package.json);
          pname = pkgJson.name;
          version = pkgJson.version;

          darwinPkg = pkgs.stdenv.mkDerivation {
            inherit pname version;

            src = pkgs.fetchurl {
              url = "https://github.com/GDR/learnharness/releases/download/v${version}/LearnHarness-${version}-arm64-mac.zip";
              hash = "sha256-2yE01hPf0h56dyZO9Z3o9Ak1qPN+qXqnGt4eC+olXIY=";
            };

            nativeBuildInputs = [
              pkgs.unzip
              pkgs.makeWrapper
              pkgs.darwin.sigtool
            ];

            sourceRoot = ".";
            unpackCmd = "unzip -q $curSrc";
            dontConfigure = true;
            dontBuild = true;
            dontFixup = true;

            installPhase = ''
              runHook preInstall

              mkdir -p "$out/Applications" "$out/bin"
              cp -a "LearnHarness.app" "$out/Applications/"
              chmod -R u+w "$out/Applications/LearnHarness.app/Contents"
              rm -rf "$out/Applications/LearnHarness.app/Contents/_CodeSignature" \
                     "$out/Applications/LearnHarness.app/Contents/CodeResources"
              codesign -f -s - "$out/Applications/LearnHarness.app/Contents/MacOS/LearnHarness"
              makeWrapper "$out/Applications/LearnHarness.app/Contents/MacOS/LearnHarness" "$out/bin/learnharness"

              runHook postInstall
            '';

            meta = with pkgs.lib; {
              description = pkgJson.description;
              homepage = "https://github.com/GDR/learnharness";
              license = licenses.agpl3Only;
              platforms = [ "aarch64-darwin" ];
              mainProgram = "learnharness";
            };
          };

          linuxPkg =
            let
              src = pkgs.fetchurl {
                url = "https://github.com/GDR/learnharness/releases/download/v${version}/LearnHarness-${version}-x86_64.AppImage";
                hash = "sha256-7zRlGDOxGOpcdEnM2UUFgBB66xg+bHGrFQdrQ7xFGOw=";
              };
              extracted = pkgs.appimageTools.extract { inherit pname version src; };
            in
            pkgs.appimageTools.wrapAppImage {
              inherit pname version;
              src = extracted;

              extraInstallCommands = ''
                install -m 444 -D ${extracted}/learnharness.desktop -t $out/share/applications
                substituteInPlace $out/share/applications/learnharness.desktop \
                  --replace-fail 'Exec=AppRun --no-sandbox %U' 'Exec=learnharness %U'
                cp -r ${extracted}/usr/share/icons $out/share
              '';

              meta = with pkgs.lib; {
                description = pkgJson.description;
                homepage = "https://github.com/GDR/learnharness";
                license = licenses.agpl3Only;
                platforms = [ "x86_64-linux" ];
                mainProgram = "learnharness";
              };
            };
        in {
          learnharness = if pkgs.stdenv.hostPlatform.isDarwin then darwinPkg else linuxPkg;
          default = self.packages.${system}.learnharness;
        }
      );

      apps = forAllSystems (system: {
        learnharness = {
          type = "app";
          program = "${self.packages.${system}.learnharness}/bin/learnharness";
        };
        default = self.apps.${system}.learnharness;
      });

      devShells = forAllSystems (system: {
        default = pkgsFor.${system}.mkShell {
          buildInputs = [
            pkgsFor.${system}.nodejs_24
          ];
        };
      });
    };
}
